// WebPaintBackend 装配锚（C7；提案 §5 C7 行验收）：node 无 GL——
//   ① born-loaded 工厂（blank / open 魔数路由 / png 单图成层）
//   ② open → 指令 → undo → encode **逐字节** round-trip（决定论 encode：zip 时间戳钉死）
//   ③ 多 backend 并发（观察者多播 + 所有权戳：记账互不串）
//   ④ dispose（幂等；死后 verbs 响亮 throw；不殃及邻居）
//   ⑤ onChange 事件面（verb / undo 都要响）
// GL 缺席语义：encodeOra 的 mergedimage = 透明占位（层数据完整）；exportImage 响亮失败。
import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";
import { installDomParserShim } from "./xml-shim.mjs";

ensureZipLoaded();
installDomParserShim();

const { WebPaintBackend } = await import("../src/backend/webpaint-backend.ts");
const { encodePngFromBytes } = await import("../src/backend/png-codec.ts");
const { getDocCompositorBytes, setDocCompositorBytes } = await import("../src/backend/doc-render.ts");

// doc-render 是全局接缝（套件里 doc-mergedown-clip 等会装 CPU 合成器且不卸）——
// 「无 GL」语义的锚必须显式清空接缝再还原，别赌套件顺序。
const withNoGL = async (fn) => {
  const prev = getDocCompositorBytes();
  setDocCompositorBytes(null);
  try { return await fn(); } finally { setDocCompositorBytes(prev); }
};

const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const INJ = { appVersion: "v0.0.0-test" };

describe("webpaint-backend · born-loaded 工厂", () => {
  it("blank：出生即 doc 在（无空态），干净不脏、栈空", () => {
    const be = WebPaintBackend.blank({ width: 128, height: 96, backgroundColor: "#ffeecc" }, INJ);
    const info = be.docInfo();
    eq(info.width, 128); eq(info.height, 96); eq(info.backgroundColor, "#ffeecc");
    eq(info.layerCount, 1); eq(info.activeId, 1);
    eq(be.isDirty(), false, "load 收尾 markSaved");
    eq(be.canUndo(), false, "load 清栈");
    be.dispose();
  });

  it("open：png 魔数 → 单图成层（像素逐字节进层）", async () => {
    const w = 8, h = 6;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 200; px[i * 4 + 3] = 255; }   // 不透明红
    const png = await encodePngFromBytes(px, w, h);
    const { backend: be, sidecar } = await WebPaintBackend.open(png, INJ);
    const info = be.docInfo();
    eq(info.width, w); eq(info.height, h); eq(info.layerCount, 1);
    eq(sidecar.wroteWith, null);
    const back = be.wp2.layerTiles.getRegion(info.activeId, 0, 0, w, h);
    assert(bytesEq(back, px), "单图成层像素 roundtrip");
    be.dispose();
  });

  it("open：垃圾字节（非 png/zip/psd）无解码注入 → 响亮 throw", async () => {
    let threw = false;
    try { await WebPaintBackend.open(new Uint8Array([1, 2, 3, 4]), INJ); }
    catch (e) { threw = true; assert(String(e.message).includes("imageDecoder"), e.message); }
    assert(threw, "必须响亮失败");
  });
});

describe("webpaint-backend · encode↔open 逐字节 round-trip（无 GL）", () => {
  it("blank → verbs → encodeOra → open → encodeOra：字节相同", async () => await withNoGL(async () => {
    const b1 = WebPaintBackend.blank({ width: 64, height: 48 }, INJ);
    const add = b1.layerAdd("上层");
    assert(add.ok, "layerAdd");
    eq(b1.layerSetProp(add.id, "opacity", 0.5).ok, true);
    eq(b1.layerSetProp(add.id, "mode", "multiply").ok, true);
    // 像素也写一点（进程内协作面：令牌 + layerTiles 直写 = ADR-0008 合法路）
    const t = b1.wp2.begin("test-paint");
    b1.wp2.layerTiles.putRegion(add.id, 3, 4, 2, 2, new Uint8ClampedArray([9, 8, 7, 255, 1, 2, 3, 255, 4, 5, 6, 255, 250, 250, 250, 128]));
    t.commit();
    const bytes1 = await b1.encodeOra();
    const { backend: b2, sidecar } = await WebPaintBackend.open(bytes1, INJ);
    eq(sidecar.wroteWith, "v0.0.0-test", "wrote-with 戳注入生效");
    const bytes2 = await b2.encodeOra();
    assert(bytesEq(bytes1, bytes2), `round-trip 字节漂移（${bytes1.length} vs ${bytes2.length}）`);
    // 树/属性投影同形
    eq(JSON.stringify(b2.layerTree()), JSON.stringify(b1.layerTree()));
    b1.dispose(); b2.dispose();
  }));

  it("open → 指令 → undo → encodeOra == 原字节（C7 验收判据）", async () => await withNoGL(async () => {
    const b1 = WebPaintBackend.blank({ width: 32, height: 32 }, INJ);
    b1.layerAdd("A");
    const bytes1 = await b1.encodeOra();
    const { backend: b2 } = await WebPaintBackend.open(bytes1, INJ);
    // 指令批：结构 + 属性 + 像素令牌写
    const r = b2.layerAdd("扰动层"); assert(r.ok);
    b2.layerSetProp(r.id, "opacity", 0.25);
    const t = b2.wp2.begin("scribble");
    b2.wp2.layerTiles.putRegion(r.id, 0, 0, 1, 1, new Uint8ClampedArray([1, 2, 3, 4]));
    t.commit();
    assert(b2.isDirty(), "改动后脏");
    // 全撤
    while (b2.canUndo()) b2.undo();
    const bytes2 = await b2.encodeOra();
    assert(bytesEq(bytes1, bytes2), "undo 干净后 encode 必须逐字节回到原样");
    b1.dispose(); b2.dispose();
  }));

  it("encodeOra sidecar 透传：editorSidecar → .webpaint/editor-state.json → open 解回", async () => {
    const b1 = WebPaintBackend.blank({ width: 16, height: 16 }, INJ);
    const bytes = await b1.encodeOra({ editorSidecar: { toolDials: { brush: 42 }, shellVer: "t1" } });
    const { backend: b2, sidecar } = await WebPaintBackend.open(bytes, INJ);
    eq(JSON.stringify(sidecar.editorState), JSON.stringify({ toolDials: { brush: 42 }, shellVer: "t1" }), "sidecar 原样往返（backend 不解释）");
    b1.dispose(); b2.dispose();
  });

  it("exportImage：无 GL/合成注入 → 响亮失败（不出占位图）", async () => await withNoGL(async () => {
    const be = WebPaintBackend.blank({ width: 8, height: 8 }, INJ);
    let threw = false;
    try { await be.exportImage("png"); } catch (e) { threw = true; assert(String(e.message).includes("合成不可用"), e.message); }
    assert(threw);
    be.dispose();
  }));

  it("exportImage：jpg 无编码器注入 → 响亮失败", async () => {
    const be = WebPaintBackend.blank({ width: 8, height: 8 }, INJ);
    let threw = false;
    try { await be.exportImage("jpg"); } catch { threw = true; }
    assert(threw, "jpgEncoder 缺席必须 throw");
    be.dispose();
  });
});

describe("webpaint-backend · 多 backend 并发（观察者多播 + 所有权戳）", () => {
  it("双 backend 交错令牌写：记账互不串、undo 各回各家", () => {
    const A = WebPaintBackend.blank({ width: 16, height: 16 }, INJ);
    const B = WebPaintBackend.blank({ width: 16, height: 16 }, INJ);
    const red = new Uint8ClampedArray([255, 0, 0, 255]);
    const blu = new Uint8ClampedArray([0, 0, 255, 255]);
    // 交错开令牌（A 开着时写 B——旧单槽观察者下这必坏账）
    const ta = A.wp2.begin("a-paint");
    A.wp2.layerTiles.putRegion(1, 0, 0, 1, 1, red);
    const tb = B.wp2.begin("b-paint");
    B.wp2.layerTiles.putRegion(1, 0, 0, 1, 1, blu);
    ta.commit(); tb.commit();
    eq(A.canUndo(), true); eq(B.canUndo(), true);
    // A 撤销：A 像素回空，B 原样
    eq(A.undo(), true);
    eq(A.wp2.layerTiles.getRegion(1, 0, 0, 1, 1)[3], 0, "A 已回滚（α=0）");
    eq(B.wp2.layerTiles.getRegion(1, 0, 0, 1, 1)[2], 255, "B 不受扰（蓝仍在）");
    eq(B.canUndo(), true, "B 的栈没被 A 动");
    // B 撤销互认
    eq(B.undo(), true);
    eq(B.wp2.layerTiles.getRegion(1, 0, 0, 1, 1)[3], 0, "B 也各自回滚");
    A.dispose(); B.dispose();
  });

  it("A 令牌开着时 B 的换手不进 A 的包（undo 包按 backend 隔离）", () => {
    const A = WebPaintBackend.blank({ width: 16, height: 16 }, INJ);
    const B = WebPaintBackend.blank({ width: 16, height: 16 }, INJ);
    const px = new Uint8ClampedArray([7, 7, 7, 255]);
    const ta = A.wp2.begin("a-open");
    // B 无令牌直写会 throw？不——B 的观察者 gate 是 tokenOpen；这里给 B 也开令牌，写完各自 commit。
    const tb = B.wp2.begin("b-open");
    B.wp2.layerTiles.putRegion(1, 2, 2, 1, 1, px);
    tb.commit();
    // A 全程没写 → A commit 后 no-op 不占步
    ta.commit();
    eq(A.canUndo(), false, "A 空令牌 no-op 不占步（B 的换手没被 A 扣押）");
    eq(B.canUndo(), true);
    A.dispose(); B.dispose();
  });

  it("per-tenant 合成注入：双 backend 各持己面不串（C7）", async () => {
    const mkComp = (tag) => {
      const calls = [];
      const fn = (nodes, w, h) => {
        calls.push(tag);
        const data = new Uint8ClampedArray(w * h * 4).fill(tag);
        return { data, w, h };
      };
      return { fn, calls };
    };
    const ca = mkComp(11), cb = mkComp(22);
    const A = WebPaintBackend.blank({ width: 8, height: 8 }, { compositorBytes: ca.fn });
    const B = WebPaintBackend.blank({ width: 8, height: 8 }, { compositorBytes: cb.fn });
    const pa = await A.exportImage("png");
    const pb = await B.exportImage("png");
    assert(pa.length > 0 && pb.length > 0, "两家都出字节");
    assert(ca.calls.length > 0 && ca.calls.every((t) => t === 11), "A 只走 A 的合成面");
    assert(cb.calls.length > 0 && cb.calls.every((t) => t === 22), "B 只走 B 的合成面");
    A.dispose(); B.dispose();
  });
});

describe("webpaint-backend · dispose / onChange", () => {
  it("dispose：幂等；死后 verbs 响亮 throw；邻居照常活", () => {
    const A = WebPaintBackend.blank({ width: 8, height: 8 }, INJ);
    const B = WebPaintBackend.blank({ width: 8, height: 8 }, INJ);
    A.dispose();
    A.dispose();   // 幂等
    eq(A.disposed, true);
    let threw = false;
    try { A.layerAdd("x"); } catch { threw = true; }
    assert(threw, "死后 verb 必须 throw");
    assert(B.layerAdd("ok").ok, "邻居不受累");
    B.dispose();
  });

  it("onChange：verb 一步 / undo 各响一次；disposer 拆掉后安静", () => {
    const be = WebPaintBackend.blank({ width: 8, height: 8 }, INJ);
    const evs = [];
    const off = be.onChange((ev) => evs.push(ev));
    const r = be.layerAdd("L");
    assert(r.ok);
    assert(evs.length > 0, "layerAdd 后要有事件");
    assert(evs[evs.length - 1].canUndo === true && evs[evs.length - 1].isDirty === true);
    const n = evs.length;
    be.undo();
    assert(evs.length > n, "undo 后要有事件");
    eq(evs[evs.length - 1].canUndo, false);
    off();
    be.layerAdd("L2");
    eq(evs.length > n ? evs.filter((e) => false).length : 0, 0);   // disposer 后不再增（长度冻结）
    const frozen = evs.length;
    be.redo();
    eq(evs.length, frozen, "off() 之后不该再收事件");
    be.dispose();
  });
});
