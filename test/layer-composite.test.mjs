// 规范合成器（deep module A）的纯逻辑：clip 基底解析 computeClipBaseForNodes。
// 画布合成（drawImage/dst-in）在 node DOM-shim 下是 no-op，无法验像素 → 真机验视觉；
// 这里只压**clip 基底解析**（survey 标记的「最大语义地雷」）：同级最近非clip可见有内容层、
// 链共基底、基底隐藏/无基底 → null、组可作基底。
import { describe, it, assert } from "./runner.mjs";
import { computeClipBaseForNodes } from "../src/layer-composite.js";

// 假节点：叶 = {clippingMask, visible, bboxW, bboxH}；组 = {isGroup:true, clippingMask, visible}
const leaf = (o = {}) => ({ clippingMask: false, visible: true, bboxW: 10, bboxH: 10, isGroup: false, ...o });
const group = (o = {}) => ({ clippingMask: false, visible: true, isGroup: true, children: [], ...o });

describe("layer-composite · computeClipBaseForNodes", () => {
  it("无 clip 层 → 全 null", () => {
    const ns = [leaf(), leaf(), leaf()];
    assert(computeClipBaseForNodes(ns).every((b) => b === null), "全 null");
  });

  it("clip 层取下方最近非clip层为基底（返回节点本身）", () => {
    const base = leaf(), clip = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([base, clip]);
    assert(out[0] === null, "基底自身无 base");
    assert(out[1] === base, "clip 基底 = 下方非clip层");
  });

  it("连续 clip 链共用同一基底（非上一颗 clip）", () => {
    const base = leaf(), c1 = leaf({ clippingMask: true }), c2 = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([base, c1, c2]);
    assert(out[1] === base && out[2] === base, "链共基底");
  });

  it("clip 取最近的非clip层（中间隔着另一基底）", () => {
    const b0 = leaf(), b1 = leaf(), clip = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([b0, b1, clip]);
    assert(out[2] === b1, "取最近 b1 而非 b0");
  });

  it("最底层就是 clip（下方无基底）→ null", () => {
    const out = computeClipBaseForNodes([leaf({ clippingMask: true }), leaf()]);
    assert(out[0] === null, "无基底 → null");
  });

  it("基底隐藏 → clip 无可用基底（null，跟基底隐显）", () => {
    const hidden = leaf({ visible: false }), clip = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([hidden, clip]);
    assert(out[1] === null, "隐藏基底不充当基底");
  });

  it("空基底（bbox=0）→ clip 无基底", () => {
    const empty = leaf({ bboxW: 0, bboxH: 0 }), clip = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([empty, clip]);
    assert(out[1] === null, "空层不充当基底");
  });

  it("组（可见）可作 clip 基底", () => {
    const g = group(), clip = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([g, clip]);
    assert(out[1] === g, "可见组充当基底");
  });

  it("隐藏组不作基底", () => {
    const g = group({ visible: false }), clip = leaf({ clippingMask: true });
    assert(computeClipBaseForNodes([g, clip])[1] === null, "隐藏组不充当基底");
  });

  it("多段 clip 各归各的基底", () => {
    const b0 = leaf(), c0 = leaf({ clippingMask: true }), b1 = leaf(), c1 = leaf({ clippingMask: true });
    const out = computeClipBaseForNodes([b0, c0, b1, c1]);
    assert(out[1] === b0 && out[3] === b1, "c0→b0, c1→b1");
  });
});
