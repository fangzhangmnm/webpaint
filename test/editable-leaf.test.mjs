// requireEditableLeaf 单谓词（Slice 4）：「能否在当前 active 写像素」一处判定。
// 纯逻辑，无 canvas。守的是所有像素命令穿同一判定（组硬拒 / 隐藏软拒 / 叶放行）。
import { describe, it, assert } from "./runner.mjs";
import { requireEditableLeaf } from "../src/editable-leaf.ts";

// 假 doc：只实现 activeEditableLeaf 依赖的 activeLayer + 谓词本体（拷自 doc.js 逻辑以独立验包装层），
//   但更稳的是直接用真 doc 的谓词。这里复用真逻辑：构造带 activeLayer 的极简 doc + 真 activeEditableLeaf。
function mkDoc(active) {
  return {
    activeLayer: active,
    activeEditableLeaf({ allowHidden = false } = {}) {
      const a = this.activeLayer;
      if (!a) return { leaf: null, reason: "none" };
      if (a.isGroup) return { leaf: null, reason: "group" };
      if (!a.visible && !allowHidden) return { leaf: null, reason: "hidden" };
      return { leaf: a, reason: null };
    },
  };
}
const leaf = (o = {}) => ({ isGroup: false, visible: true, ...o });
const grp = () => ({ isGroup: true, visible: true });

describe("requireEditableLeaf", () => {
  it("可写叶 → 返回叶，不报错", () => {
    const L = leaf();
    let status = null;
    const got = requireEditableLeaf(mkDoc(L), (m) => (status = m));
    assert(got === L, "返回该叶");
    assert(status === null, "无状态行");
  });

  it("组 → null + 标准状态行", () => {
    let status = null;
    const got = requireEditableLeaf(mkDoc(grp()), (m) => (status = m));
    assert(got === null, "组不可写");
    assert(/图层组/.test(status), `组文案，实得「${status}」`);
  });

  it("隐藏叶 → null + 状态行（默认不放行）", () => {
    let status = null;
    const got = requireEditableLeaf(mkDoc(leaf({ visible: false })), (m) => (status = m));
    assert(got === null, "隐藏不可写");
    assert(/隐藏/.test(status), `隐藏文案，实得「${status}」`);
  });

  it("隐藏叶 + allowHidden → 放行", () => {
    const L = leaf({ visible: false });
    const got = requireEditableLeaf(mkDoc(L), () => {}, { allowHidden: true });
    assert(got === L, "allowHidden 放行隐藏叶");
  });

  it("无 active → null + 状态行", () => {
    let status = null;
    const got = requireEditableLeaf(mkDoc(null), (m) => (status = m));
    assert(got === null && /没有活动图层/.test(status), "无 active");
  });
});
