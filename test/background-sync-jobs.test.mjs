// background-sync-jobs：空闲调度深模块（假时钟全可测）。
// 钉死的契约：quota 表按停顿时长给预算、优先级降序轮询、requeue 排队尾、
// 输入插队「跑完上一个就停」、抛错 handler 本轮除名不死循环。
import { describe, it, assert, eq } from "./runner.mjs";
import { BackgroundSyncJobs } from "../src/background-sync-jobs.ts";

// 假时钟：now 可控；advance 模拟 handler 耗时。
function clock(t0 = 0) {
  let t = t0;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}
const TABLE = [
  { afterIdleMs: 1000, quotaMs: 5 },
  { afterIdleMs: 5000, quotaMs: 20 },
];

describe("bg-jobs · quota 表", () => {
  it("没停够最小档 → 一点不跑；过档 → 跑；更长空闲 → 更大预算", () => {
    const c = clock();
    const jobs = new BackgroundSyncJobs({ quotaTable: TABLE, now: c.now });
    let calls = 0;
    jobs.register("j", 0, () => { calls++; c.advance(4); return "requeue"; });   // 每次吃 4ms 还要
    c.set(500); jobs.tick();
    eq(calls, 0, "空闲 500ms < 1000ms 档 → 不跑");
    c.set(1100); jobs.tick();
    eq(calls, 2, "5ms 预算 / 4ms 一口 → 两口后超预算停");
    calls = 0; c.set(999_999); jobs.tick();
    eq(calls, 5, "20ms 预算 / 4ms 一口 → 5 口");
  });
});

describe("bg-jobs · 优先级与 requeue", () => {
  it("优先级降序轮询；requeue 排本轮队尾（协作式让位）", () => {
    const c = clock();
    const jobs = new BackgroundSyncJobs({ quotaTable: [{ afterIdleMs: 0, quotaMs: 100 }], now: c.now });
    const order = [];
    jobs.register("low", 1, () => { order.push("low"); c.advance(1); return "done"; });
    jobs.register("hi", 9, () => { order.push("hi"); c.advance(1); return order.filter(x => x === "hi").length < 2 ? "requeue" : "done"; });
    jobs.register("mid", 5, () => { order.push("mid"); c.advance(1); return "done"; });
    c.set(10); jobs.tick();
    eq(JSON.stringify(order), JSON.stringify(["hi", "mid", "low", "hi"]), "hi 先跑，requeue 后排到 low 之后再来一口");
  });

  it("注销的 handler 不再被调", () => {
    const c = clock();
    const jobs = new BackgroundSyncJobs({ quotaTable: [{ afterIdleMs: 0, quotaMs: 100 }], now: c.now });
    let calls = 0;
    const unreg = jobs.register("j", 0, () => { calls++; c.advance(1); return "done"; });
    c.set(10); jobs.tick();
    eq(calls, 1);
    unreg();
    c.set(20); jobs.tick();
    eq(calls, 1, "注销后不跑");
  });
});

describe("bg-jobs · 输入插队", () => {
  it("handler 内 noteInput → 跑完当前这个就停，且空闲时钟归零", () => {
    const c = clock();
    const jobs = new BackgroundSyncJobs({ quotaTable: TABLE, now: c.now });
    const order = [];
    jobs.register("a", 9, () => { order.push("a"); jobs.noteInput(); c.advance(1); return "requeue"; });
    jobs.register("b", 1, () => { order.push("b"); c.advance(1); return "done"; });
    c.set(2000); jobs.tick();
    eq(JSON.stringify(order), JSON.stringify(["a"]), "a 里插队 → b 不跑（跑完上一个就停）");
    c.set(2500); jobs.tick();   // noteInput 发生在 t=2000 → 空闲只有 500ms < 1000 档
    eq(JSON.stringify(order), JSON.stringify(["a"]), "空闲时钟已归零 → 不够档不跑");
  });

  it("抛错的 handler 本轮除名（不死循环），下轮照常重试；onError 收到", () => {
    const c = clock();
    let reported = null;
    const jobs = new BackgroundSyncJobs({
      quotaTable: [{ afterIdleMs: 0, quotaMs: 100 }], now: c.now,
      onError: (name, e) => { reported = `${name}:${String(e)}`; },
    });
    let boomCalls = 0, okCalls = 0;
    jobs.register("boom", 9, () => { boomCalls++; c.advance(1); throw new Error("x"); });
    jobs.register("ok", 1, () => { okCalls++; c.advance(1); return "done"; });
    c.set(10); jobs.tick();
    eq(boomCalls, 1, "抛错只跑一次（本轮除名）");
    eq(okCalls, 1, "别的 handler 不受影响");
    assert(reported && reported.startsWith("boom:"), "onError 上报");
    c.set(20); jobs.tick();
    eq(boomCalls, 2, "下轮照常重试");
  });
});

// deflate codec（vendored fflate sync 路径）——池的压缩管就吃这一个接口
import { deflateTileCodec } from "../src/tiles/cpu-tile-compression.ts";
import { CpuTilePool, bytesPerTile } from "../src/tiles/cpu-tile-pool.ts";

describe("cpu-tile-compression · deflate codec", () => {
  it("三格式往返无损 + 平坦内容真的变小", () => {
    for (const [fmt, ts] of [["rgba8", 64], ["gray8", 64], ["bit1", 64]]) {
      const len = bytesPerTile(fmt, ts);
      const src = new Uint8Array(len);
      for (let i = 0; i < len; i += 7) src[i] = (i * 13) % 256;   // 稀疏图案（可压）
      const comp = deflateTileCodec.compress(src);
      const back = deflateTileCodec.decompress(comp, len);
      eq(back.byteLength, len, `${fmt} 长度`);
      let same = true;
      for (let i = 0; i < len; i++) if (back[i] !== src[i]) { same = false; break; }
      assert(same, `${fmt} 逐字节无损`);
      assert(comp.byteLength < len, `${fmt} 稀疏内容压得动（${comp.byteLength} < ${len}）`);
    }
  });

  it("接进池：quota 超额阻塞压缩 → 读回内容无损（端到端）", () => {
    const ts = 32;
    const one = bytesPerTile("rgba8", ts);
    const pool = new CpuTilePool({ tileSize: ts, rawQuotaBytes: one * 2, codec: deflateTileCodec });
    const mk = (seed) => { const b = new Uint8Array(one); for (let i = 3; i < one; i += 4) b[i] = (seed + i) % 251; return b; };
    const h1 = pool.createTile("rgba8", mk(1));
    const ref = h1.bytes().slice();          // 压缩前基准
    pool.createTile("rgba8", mk(2));
    pool.createTile("rgba8", mk(3));         // 超额 → h1 被真 deflate
    assert(h1.isCompressed(), "最古老被压");
    const back = h1.bytes();                 // 同步解压
    let same = true;
    for (let i = 0; i < one; i++) if (back[i] !== ref[i]) { same = false; break; }
    assert(same, "deflate 往返逐字节无损");
  });
});
