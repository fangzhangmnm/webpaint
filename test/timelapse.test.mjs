// Timelapse 核心域验收：取景框几何 / 调和衰减 / 帧合成 / mux↔demux round-trip / 录制态自愈 / 编码器注入槽。
// spec = ai-docs/20260819-timelapse-spec.md
import { describe, it, assert, eq } from "./runner.mjs";
const jeq = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);   // eq 是严格 ===，对象/数组走序列化比较
import {
  timelapseFrameDims, timelapseFitRect, timelapseDebounceMs, TimelapseSampler,
  composeTimelapseFrame, timelapseTier, TIMELAPSE_BASE_DEBOUNCE_MS,
} from "../src/backend/timelapse/timelapse-core.ts";
import { muxTimelapse, demuxTimelapse, avcCodecString } from "../src/backend/timelapse/timelapse-mux.ts";
import { TimelapseDocState } from "../src/backend/timelapse/timelapse-state.ts";
import {
  setTimelapseEncoderCtor, timelapseProbeSupport, TimelapseMotionEncoder, encodeTailFrame,
} from "../src/backend/timelapse/timelapse-encoder.ts";

// ---- 取景框几何 ----

describe("timelapse · 取景框", () => {
  it("1:1 512 → 512×512", () => jeq(timelapseFrameDims({ aspectW: 1, aspectH: 1, longEdge: 512 }), { w: 512, h: 512 }));
  it("4:3 横 → 长边给宽", () => jeq(timelapseFrameDims({ aspectW: 4, aspectH: 3, longEdge: 512 }), { w: 512, h: 384 }));
  it("9:16 竖 → 长边给高，短边取偶", () => jeq(timelapseFrameDims({ aspectW: 9, aspectH: 16, longEdge: 512 }), { w: 288, h: 512 }));
  it("16:9 720 → 720×406（405 取偶到 406）", () => jeq(timelapseFrameDims({ aspectW: 16, aspectH: 9, longEdge: 720 }), { w: 720, h: 406 }));

  it("fit：方进方 = 满幅", () => jeq(timelapseFitRect(1024, 1024, 512, 512), { dx: 0, dy: 0, dw: 512, dh: 512 }));
  it("fit：横图进方框 = 上下白边居中", () => {
    const r = timelapseFitRect(2048, 1024, 512, 512);
    jeq(r, { dx: 0, dy: 128, dw: 512, dh: 256 });
  });
  it("fit：小画布允许放大（诚实占满）", () => eq(timelapseFitRect(64, 64, 512, 512).dw, 512));
});

// ---- 调和衰减 ----

describe("timelapse · 调和衰减", () => {
  it("n=0 → 基础 2s；n=N₀ → 4s；n=3N₀ → 8s（线性走调和）", () => {
    const n0 = timelapseTier(512).n0;
    eq(timelapseDebounceMs(0, 512), TIMELAPSE_BASE_DEBOUNCE_MS);
    eq(timelapseDebounceMs(n0, 512), TIMELAPSE_BASE_DEBOUNCE_MS * 2);
    eq(timelapseDebounceMs(3 * n0, 512), TIMELAPSE_BASE_DEBOUNCE_MS * 4);
  });
  it("未知档位 throw（防手滑塞任意分辨率）", () => {
    let threw = false;
    try { timelapseTier(500); } catch { threw = true; }
    assert(threw, "500 不是合法档位");
  });
  it("sampler：首 commit 必采；窗口内合并但 n 照涨", () => {
    const s = new TimelapseSampler(512, 0);
    assert(s.noteCommit(1000) === true, "首帧采");
    assert(s.noteCommit(1500) === false, "0.5s 后合并");
    assert(s.noteCommit(2000) === false, "1s 后仍合并");
    eq(s.n, 3);
    assert(s.noteCommit(1000 + timelapseDebounceMs(4, 512) + 1) === true, "过窗采帧");
  });
  it("sampler：n 从持久化值续起（衰减跨 session 连续）", () => {
    const s = new TimelapseSampler(512, 1000);
    s.noteCommit(0);
    eq(s.n, 1001);
  });
});

// ---- 帧合成（白底白边，不走 canvas） ----

describe("timelapse · 帧合成", () => {
  it("全透明画布 → 纯白不透明帧", () => {
    const src = new Uint8ClampedArray(4 * 4 * 4);   // 全 0（透明）
    const out = composeTimelapseFrame(src, 4, 4, 8, 8);
    eq(out.length, 8 * 8 * 4);
    for (let i = 0; i < out.length; i++) assert(out[i] === 255, `像素 ${i} 应为白/不透明，得 ${out[i]}`);
  });
  it("不透明红画布进宽框 → 中间红、两侧白边", () => {
    const src = new Uint8ClampedArray(2 * 2 * 4);
    for (let i = 0; i < 4; i++) { src[i * 4] = 200; src[i * 4 + 3] = 255; }
    const out = composeTimelapseFrame(src, 2, 2, 8, 4);   // 2×2 fit 进 8×4 → 4×4 居中，左右各 2 白
    const px = (x, y) => out[(y * 8 + x) * 4];
    eq(px(0, 0), 255); eq(px(4, 1), 200); eq(px(7, 3), 255);
  });
  it("半透明像素 over 白：a=0.5 的黑 → 127.5 灰", () => {
    const src = new Uint8ClampedArray([0, 0, 0, 128]);
    const out = composeTimelapseFrame(src, 1, 1, 1, 1);   // 奇数框仅测合成数学，不走编码
    assert(Math.abs(out[0] - 127) <= 1, `期望 ~127 得 ${out[0]}`);
    eq(out[3], 255);
  });
});

// ---- mux ↔ demux round-trip ----

const FAKE_AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
const nalu = (tag, len = 16) => {
  const b = new Uint8Array(4 + len);
  b[3] = len;                       // length-prefixed 假 NALU
  for (let i = 0; i < len; i++) b[4 + i] = (tag * 31 + i) & 0xff;
  return b;
};

describe("timelapse · mux↔demux", () => {
  it("codec string 从 avcC 推导", () => eq(avcCodecString(FAKE_AVCC), "avc1.640028"));

  it("round-trip：样本字节/顺序/key 标志/avcC/尺寸 全保真", () => {
    const motion = [
      { bytes: nalu(1), key: true },
      { bytes: nalu(2), key: false },
      { bytes: nalu(3), key: false },
      { bytes: nalu(4), key: true },   // 断片重开的 IDR
      { bytes: nalu(5), key: false },
    ];
    const tail = { bytes: nalu(9, 64), key: true };
    const mp4 = muxTimelapse(motion, tail, FAKE_AVCC, 512, 384);
    eq(String.fromCharCode(...mp4.slice(4, 8)), "ftyp");
    const d = demuxTimelapse(mp4);
    eq(d.width, 512); eq(d.height, 384);
    jeq(Array.from(d.avcC), Array.from(FAKE_AVCC));
    eq(d.samples.length, 6);
    for (let i = 0; i < 5; i++) {
      jeq(Array.from(d.samples[i].bytes), Array.from(motion[i].bytes), `样本 ${i} 字节`);
      eq(d.samples[i].key, motion[i].key, `样本 ${i} key`);
    }
    eq(d.samples[5].key, true);
    jeq(Array.from(d.samples[5].bytes), Array.from(tail.bytes));
  });

  it("零运动帧（刚开录就保存）：mp4 = 仅尾帧，仍可回读", () => {
    const mp4 = muxTimelapse([], { bytes: nalu(7), key: true }, FAKE_AVCC, 512, 512);
    eq(demuxTimelapse(mp4).samples.length, 1);
  });

  it("烂字节 → throw（调用方自愈）", () => {
    let threw = false;
    try { demuxTimelapse(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112])); } catch { threw = true; }
    assert(threw, "无 moov 应 throw");
  });
});

// ---- 录制态：生命周期 + 持久化 round-trip + 自愈 ----

describe("timelapse · 录制态", () => {
  const SETTINGS = { aspectW: 1, aspectH: 1, longEdge: 512 };
  const mkState = () => {
    const st = new TimelapseDocState();
    st.startRecording(SETTINGS);
    st.pushMotionSample({ bytes: nalu(1), key: true }, FAKE_AVCC);
    st.pushMotionSample({ bytes: nalu(2), key: false });
    return st;
  };

  it("开录 pin 设置；重复开录 throw（换设置=先 clear）", () => {
    const st = mkState();
    let threw = false;
    try { st.startRecording(SETTINGS); } catch { threw = true; }
    assert(threw, "已有录像不准再 startRecording");
  });

  it("保存→回读 round-trip：motion 保真、尾帧被截、n/开关/设置续上", () => {
    const st = mkState();
    st.sampler.noteCommit(0); st.sampler.noteCommit(1);   // n=2
    const out = st.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);
    assert(out && out.mp4.length > 0, "应产出 mp4");
    const back = TimelapseDocState.restore(out.json, out.mp4);
    eq(back.restoreIssue, null);
    eq(back.on, true);
    jeq(back.settings, SETTINGS);
    eq(back.sampler.n, 2);
    eq(back.motion.length, 2);                             // 尾帧截掉
    jeq(Array.from(back.motion[1].bytes), Array.from(nalu(2)));
    jeq(Array.from(back.avcC), Array.from(FAKE_AVCC));
  });

  it("冻结 passthrough：暂停后保存 = 原字节原样、尾帧不刷", () => {
    const st = mkState();
    const first = st.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);
    st.pause();
    const second = st.serializeForSave({ bytes: nalu(8), key: true }, 512, 512);   // 新尾帧必须被无视
    jeq(Array.from(second.mp4), Array.from(first.mp4));
    const back = TimelapseDocState.restore(second.json, second.mp4);
    eq(back.on, false);
    back.resume();
    eq(back.on, true);
  });

  it("无录像文档 → 无 entry；clear 后同", () => {
    eq(new TimelapseDocState().serializeForSave(null, 512, 512), null);
    const st = mkState();
    st.clear();
    eq(st.serializeForSave(null, 512, 512), null);
  });

  it("自愈：烂 json / mp4 缺失 / 烂 mp4 → 空态 + issue 标记，绝不 throw", () => {
    eq(TimelapseDocState.restore("{oops", null).restoreIssue, "corrupt-json");
    const st = mkState();
    const out = st.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);
    eq(TimelapseDocState.restore(out.json, null).restoreIssue, "mp4-missing");
    eq(TimelapseDocState.restore(out.json, out.mp4.slice(0, 40)).restoreIssue, "corrupt-mp4");
    eq(TimelapseDocState.restore(null, null).restoreIssue, null);   // 从没开过录=健康
  });
});

// ---- 编码器注入槽（mock VideoEncoder） ----

function mockEncoderCtor({ failOn = -1, supported = true } = {}) {
  const calls = { configured: [], encoded: [], closed: 0 };
  let seq = 0;
  const ctor = class {
    constructor({ output, error }) { this.output = output; this.error = error; }
    configure(cfg) { calls.configured.push(cfg); }
    encode(frame, opts) {
      const i = seq++;
      calls.encoded.push({ frame, key: !!opts?.keyFrame });
      if (i === failOn) { this.error(new Error("boom")); return; }
      const bytes = new Uint8Array([i, opts?.keyFrame ? 1 : 0, 42]);
      this.output(
        { type: opts?.keyFrame ? "key" : "delta", byteLength: 3, copyTo: (d) => d.set(bytes) },
        i === 0 ? { decoderConfig: { description: FAKE_AVCC.buffer.slice(0) } } : undefined,
      );
    }
    async flush() {}
    close() { calls.closed++; }
  };
  ctor.isConfigSupported = async () => ({ supported });
  return { ctor, calls };
}

describe("timelapse · 编码器注入槽", () => {
  it("probe：mock 支持/不支持/无构造器三态", async () => {
    const { ctor } = mockEncoderCtor({ supported: true });
    setTimelapseEncoderCtor(ctor);
    eq(await timelapseProbeSupport(512, 512), true);
    setTimelapseEncoderCtor(mockEncoderCtor({ supported: false }).ctor);
    eq(await timelapseProbeSupport(512, 512), false);
    setTimelapseEncoderCtor(null);
    eq(await timelapseProbeSupport(512, 512), false);
  });

  it("M：avcC 捕获 + 强制 IDR 节律 + drain 清空", async () => {
    const { ctor, calls } = mockEncoderCtor();
    setTimelapseEncoderCtor(ctor);
    const m = new TimelapseMotionEncoder(512, 512, 250_000, 3);   // 每 3 帧强制 key
    m.encode("f0", true);
    m.encode("f1"); m.encode("f2"); m.encode("f3");   // f3 = 第 4 帧，距上个 key 已 3 帧 → 强制 key
    const samples = await m.drain();
    eq(samples.length, 4);
    jeq(samples.map(s => s.key), [true, false, false, true]);
    jeq(Array.from(m.avcC), Array.from(FAKE_AVCC));
    eq((await m.drain()).length, 0);                   // drain 后清空
    m.close();
    eq(calls.closed, 1);
  });

  it("M：编码器炸 → dead 标记，后续 encode 静默丢弃（自愈=止损）", async () => {
    const { ctor } = mockEncoderCtor({ failOn: 1 });
    setTimelapseEncoderCtor(ctor);
    const m = new TimelapseMotionEncoder(512, 512, 250_000, 300);
    m.encode("f0", true);
    m.encode("f1");                                    // 炸
    m.encode("f2");                                    // 应被丢弃
    const samples = await m.drain();
    eq(samples.length, 1);
    assert(m.dead instanceof Error, "dead 应携带原错误");
  });

  it("F：一次性尾帧 = 单 key 样本 + 用完即 close", async () => {
    const { ctor, calls } = mockEncoderCtor();
    setTimelapseEncoderCtor(ctor);
    const { sample, avcC } = await encodeTailFrame("tail", 512, 512, 1_000_000);
    eq(sample.key, true);
    jeq(Array.from(avcC), Array.from(FAKE_AVCC));
    eq(calls.closed, 1);
    eq(calls.encoded.length, 1);
    eq(calls.encoded[0].key, true);
  });
});
