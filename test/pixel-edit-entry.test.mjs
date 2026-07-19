// PixelEdit entry 契约（缺陷 B 回归）—— 压缩结果必须落在 handler 读的那个字段上。
//
// 缺陷 B：layers-panel 的「清空图层」手搓了一条 stroke entry，push 时给了 beforeBlob:null，
// 却把 compressPixelSnap 的结果写进 `before.blob`；而 stroke handler 读的是 `e.beforeBlob`。
// compressPixelSnap 压缩成功会把 `snap.imageData` 置 null 释放 raw —— 于是几毫秒后这条 entry
// 两头皆空（imageData 没了、beforeBlob 仍是 null，唯一残存的 before.blob 没人读），undo 走
// `if (!blob)` 分支恢复出「旧 bbox + 零像素」。静默丢画，且是竞态（压缩落地前撤销反而正常）。
//
// 修法 = 删除重复实现：清空图层改走 PixelEditTx.commit，使它成为 stroke/liquify entry 的
// **唯一**构造点，这个错误变得不可表达。本测试钉住那个唯一构造点的契约。
//
// 注：node 里 dom-shim 的 canvas 是 no-op（toBlob 永不回调）→ 压缩永不落地、applyPixelSnap 总走
// imageData 分支，**会掩盖此 bug**。所以这里显式换上一个真会回调的 toBlob。
import { describe, it, assert, eq } from "./runner.mjs";

// **有真缓冲**的 canvas stub（不是 no-op）：Layer.snapshot 走 materialize → putImageData → getImageData，
// 只有真的存下像素，undo 的「逐字节回到清空前」才验得动。（layer-tree 那套 no-op stub 只做结构验收，
// 它头注释里的「不验像素」说的就是这个限制。）
function makeCtx(cv) {
  const ctx = {
    putImageData(img, dx = 0, dy = 0) {
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4, di = ((dy + y) * cv.width + (dx + x)) * 4;
        cv.buf[di] = img.data[si]; cv.buf[di + 1] = img.data[si + 1];
        cv.buf[di + 2] = img.data[si + 2]; cv.buf[di + 3] = img.data[si + 3];
      }
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const si = ((y + yy) * cv.width + (x + xx)) * 4, di = (yy * w + xx) * 4;
        out[di] = cv.buf[si]; out[di + 1] = cv.buf[si + 1]; out[di + 2] = cv.buf[si + 2]; out[di + 3] = cv.buf[si + 3];
      }
      return { data: out, width: w, height: h };
    },
  };
  return new Proxy(ctx, { get(t, p) { return p in t ? t[p] : (() => {}); }, set(t, p, v) { t[p] = v; return true; } });
}
class StubCanvas {
  constructor(w, h) { this.width = w || 1; this.height = h || 1; this.buf = new Uint8ClampedArray(this.width * this.height * 4); this._ctx = makeCtx(this); }
  getContext() { return this._ctx; }
}
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();
// 单 await 回合（见 layer-tree/ora-tree 的同款注释：多一个顶层 await 会毒 selection-morph 的 OSC-stub）。
const [{ PaintDoc }, { PixelEdit }, { UndoStack }] = await Promise.all([
  import("../src/doc.ts"),
  import("../src/pixel-edit.ts"),
  import("../src/history.ts"),
]);
globalThis.OffscreenCanvas = _prevOSC;

const T = (name, fn) => it(name, () => { useStub(); return fn(); });   // return：async 用例的 promise 不能吞

// dom-shim 的 canvas 是 no-op FakeNode（**没有** toBlob）→ 带内容 commit 会直接炸。
// 这里注入一个真会回调的 toBlob：result=Blob 模拟压缩成功（imageData 被释放）、result=null 模拟
// 压缩失败（imageData 保留，走同步回退路径）。两条都是浏览器里真实会发生的。
const SENTINEL = { __fakeBlob: true };
function withToBlob(result, fn) {
  const prev = document.createElement;
  document.createElement = (tag) => {
    if (tag !== "canvas") return prev.call(document, tag);
    return new (class { constructor() { this.width = 1; this.height = 1; this.buf = new Uint8ClampedArray(4); this._ctx = makeCtx(this); } getContext() { return this._ctx; } toBlob(cb) { cb(result); } })();
  };
  try { return fn(); } finally { document.createElement = prev; }
}

function paint(L, ox, oy, w, h) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = 200; a[i + 1] = 100; a[i + 2] = 50; a[i + 3] = 255; }
  L.pixels.putRegion(ox, oy, w, h, a);
}

describe("PixelEdit entry 契约（缺陷 B：清空图层 undo 空恢复）", () => {
  T("commit 出的 entry：压缩结果落在 beforeBlob/afterBlob（= handler 读的字段）", () => {
    const doc = new PaintDoc();
    const history = new UndoStack();
    const pe = new PixelEdit({ doc, history });
    const L = doc.activeLayer;
    paint(L, 20, 20, 64, 64);

    withToBlob(SENTINEL, () => {
      const tx = pe.begin(L, "stroke");
      L.clearAll();
      assert(tx.commit(), "commit 成功");
    });

    const entry = history.entries[history.index];
    eq(entry.type, "stroke", "entry 类型");
    eq(entry.layerId, L.id, "entry 层 id");
    // 承重断言：压缩落地后，唯一还拿得到像素的地方必须是 handler 读的那个字段。
    eq(entry.beforeBlob, SENTINEL, "before 的压缩结果落在 entry.beforeBlob（不是 entry.before.blob）");
    eq(entry.before.imageData, null, "压缩成功后 imageData 已被释放——所以落点错了就等于丢画");
    assert(entry.before.blob === undefined,
      "绝不该写进 before.blob（那是 layerSpec 的字段，stroke handler 不读它）");
  });

  T("清空图层：undo 能拿回像素（压缩尚未落地时走 imageData 路径）", async () => {
    const doc = new PaintDoc();
    const history = new UndoStack();
    const pe = new PixelEdit({ doc, history });
    const L = doc.activeLayer;
    paint(L, 30, 30, 40, 40);
    const before = L.pixels.getRegion(0, 0, doc.width, doc.height);

    // 压缩失败（toBlob 返 null）→ imageData 保留 → undo 走同步回退路径。
    withToBlob(null, () => {
      const tx = pe.begin(L, "stroke");
      L.clearAll();
      assert(tx.commit(), "commit");
    });
    eq(L.pixels.tileCount, 0, "已清空");

    await history.undo();
    const after = L.pixels.getRegion(0, 0, doc.width, doc.height);
    let same = after.length === before.length;
    if (same) for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { same = false; break; }
    assert(same, "undo 后像素逐字节回到清空前");
  });

  T("layer 中途被删 → commit 不入栈（不留悬空 entry）", () => {
    const doc = new PaintDoc();
    const history = new UndoStack();
    const pe = new PixelEdit({ doc, history });
    const L = doc.addLayer();
    paint(L, 10, 10, 32, 32);

    const tx = pe.begin(L, "stroke");
    L.clearAll();
    doc.removeLayer(L.id);
    withToBlob(null, () => assert(!tx.commit(), "层没了 → 不入栈"));
    eq(history.entries.length, 0, "栈里没有悬空 entry");
  });
});
