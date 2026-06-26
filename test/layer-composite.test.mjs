// 规范合成器（deep module A）的纯逻辑：clip 基底解析 computeClipBaseForNodes。
// 画布合成（drawImage/dst-in）在 node DOM-shim 下是 no-op，无法验像素 → 真机验视觉；
// 这里只压**clip 基底解析**（survey 标记的「最大语义地雷」）：同级最近非clip可见有内容层、
// 链共基底、基底隐藏/无基底 → null、组可作基底。
import { describe, it, assert } from "./runner.mjs";
import { computeClipBaseForNodes, compositeLayers } from "../src/layer-composite.ts";

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

// Slice 2：floatFor 接缝 = 浮层骑在源层 z（note #2）。DOM-shim drawImage 是 no-op，
//   故用**记录 ctx** 验 drawImage **顺序**（不验像素）：浮层画在源层之后、上方层之前。
describe("layer-composite · floatFor z-order 接缝", () => {
  // 记录每次 drawImage 的第一个参数的 __tag（画布身份），按调用顺序。
  const recCtx = () => {
    const order = [];
    return {
      order,
      globalAlpha: 1, globalCompositeOperation: "source-over",
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      drawImage(img) { order.push(img && img.__tag ? img.__tag : "?"); },
    };
  };
  // 叶节点：带 __tag 画布；非 clip、可见、有内容。
  const pxLeaf = (tag, o = {}) => ({
    clippingMask: false, visible: true, isGroup: false,
    bboxX: 0, bboxY: 0, bboxW: 10, bboxH: 10, opacity: 1, mode: "source-over",
    canvas: { __tag: tag }, ...o,
  });

  it("浮层画在源层之后、上方层之前（A,B,float,C）", () => {
    const A = pxLeaf("A"), B = pxLeaf("B"), C = pxLeaf("C");   // 底→顶
    const floatRender = { canvas: { __tag: "float" }, dstX: 0, dstY: 0 };
    const ctx = recCtx();
    compositeLayers(ctx, [A, B, C], { floatFor: (n) => (n === B ? floatRender : null) });
    assert(ctx.order.join(",") === "A,B,float,C",
      `期望 A,B,float,C 实得 ${ctx.order.join(",")}`);
  });

  it("无 floatFor → 不画浮层（A,B,C）", () => {
    const A = pxLeaf("A"), B = pxLeaf("B"), C = pxLeaf("C");
    const ctx = recCtx();
    compositeLayers(ctx, [A, B, C], {});
    assert(ctx.order.join(",") === "A,B,C", `期望 A,B,C 实得 ${ctx.order.join(",")}`);
  });

  it("源层被浮层挖空（空 bbox）仍画浮层", () => {
    const A = pxLeaf("A");
    const empty = pxLeaf("B", { bboxW: 0, bboxH: 0 });          // 浮层把源层挖空
    const floatRender = { canvas: { __tag: "float" }, dstX: 0, dstY: 0 };
    const ctx = recCtx();
    compositeLayers(ctx, [A, empty], { floatFor: (n) => (n === empty ? floatRender : null) });
    assert(ctx.order.join(",") === "A,float", `期望 A,float 实得 ${ctx.order.join(",")}`);
  });
});

// ignoreSelfClip：单层/单组导出（scope==="active"）。语义＝只忽略**被直接选中的顶层节点自身**
//   对外部兄弟的 clip（基底不在导出里）；组**内部**的 clip 一律照常生效（不向子层传播）。
//   验证手段：clipped 路径走 _drawLeafClipped → 调 opts.clipTmp；故用 clipTmp 探针判定「是否走了裁剪」。
describe("layer-composite · ignoreSelfClip 单层/单组导出", () => {
  const recCtx = () => {
    const order = [];
    return {
      order, globalAlpha: 1, globalCompositeOperation: "source-over",
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      drawImage(img) { order.push(img && img.__tag ? img.__tag : "?"); },
    };
  };
  const pxLeaf = (tag, o = {}) => ({
    clippingMask: false, visible: true, isGroup: false,
    bboxX: 0, bboxY: 0, bboxW: 10, bboxH: 10, opacity: 1, mode: "source-over",
    canvas: { __tag: tag }, ...o,
  });
  const grp = (children, o = {}) => ({
    isGroup: true, clippingMask: false, visible: true, opacity: 1,
    mode: "pass-through", children, ...o,
  });
  // clipTmp 探针：记录被调次数；返回一个最小可用离屏（getContext 给足 _drawLeafClipped 用的方法）。
  const clipTmpSpy = () => {
    const calls = [];
    const fn = (w, h) => {
      calls.push([w, h]);
      const tctx = {
        globalAlpha: 1, globalCompositeOperation: "source-over",
        setTransform() {}, clearRect() {}, drawImage() {},
      };
      return { __tag: "clipped", getContext: () => tctx };
    };
    fn.calls = calls;
    return fn;
  };

  it("单个 clip 叶单独导出 → 仍出 raw 像素（不因「有clip无基底」整张消失）", () => {
    const ctx = recCtx();
    compositeLayers(ctx, [pxLeaf("L", { clippingMask: true })], { ignoreSelfClip: true });
    assert(ctx.order.join(",") === "L", `期望 L（raw 像素）实得 "${ctx.order.join(",")}"`);
  });

  it("反例：不带 ignoreSelfClip 时同一 clip 叶无基底 → 整张消失（确认 flag 的必要性）", () => {
    const ctx = recCtx();
    compositeLayers(ctx, [pxLeaf("L", { clippingMask: true })], {});
    assert(ctx.order.length === 0, `期望空（被跳过）实得 "${ctx.order.join(",")}"`);
  });

  it("选中组单独导出：组内 clip 照常生效（clipTmp 被调）——ignoreSelfClip 不向子层传播", () => {
    const base = pxLeaf("base");
    const clip = pxLeaf("clip", { clippingMask: true });
    const g = grp([base, clip]);                       // 组内：clip 裁到 base
    const ctx = recCtx();
    const spy = clipTmpSpy();
    compositeLayers(ctx, [g], { ignoreSelfClip: true, clipTmp: spy });
    assert(spy.calls.length === 1, `组内 clip 应走裁剪路径（clipTmp 调 1 次）实得 ${spy.calls.length}`);
    assert(ctx.order.join(",") === "base,clipped",
      `期望 base 直绘 + clip 经离屏裁剪后 blit，实得 "${ctx.order.join(",")}"`);
  });

  it("嵌套组：深层 clip 也照常生效（ignoreSelfClip 在每层递归都被清零，不渗透到任意深度）", () => {
    const innerBase = pxLeaf("inner-base");
    const innerClip = pxLeaf("inner-clip", { clippingMask: true });
    const inner = grp([innerBase, innerClip]);         // 子组内：inner-clip 裁到 inner-base
    const outer = grp([pxLeaf("sib"), inner]);         // 外组：一个旁层 + 子组
    const ctx = recCtx();
    const spy = clipTmpSpy();
    compositeLayers(ctx, [outer], { ignoreSelfClip: true, clipTmp: spy });
    assert(spy.calls.length === 1, `深层 clip 仍应走裁剪路径（clipTmp 调 1 次）实得 ${spy.calls.length}`);
    assert(ctx.order.join(",") === "sib,inner-base,clipped",
      `期望旁层 + 子组内 base 直绘 + 深层 clip 裁剪后 blit，实得 "${ctx.order.join(",")}"`);
  });
});
