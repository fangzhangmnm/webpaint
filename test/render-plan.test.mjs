// render-plan 分区 golden（S7b；spec :123-159）。纯逻辑：树+updated+bg → 步骤表/段/pin。
import { describe, it, assert, eq } from "./runner.mjs";
import { buildPlan } from "../src/backend/gl/render-plan.ts";

// 节点构造器（mode 已按约定预归一）。
const L = (id, o = {}) => ({
  kind: "leaf", id, opacity: o.opacity ?? 1, mode: o.mode ?? "source-over",
  clip: !!o.clip, visible: o.visible !== false, hasContent: o.hasContent !== false,
  float: !!o.float, overlay: !!o.overlay,
});
const G = (id, children, o = {}) => ({
  kind: "group", id, opacity: o.opacity ?? 1, mode: o.mode ?? "pass-through",
  clip: !!o.clip, visible: o.visible !== false, children,
});
// 步骤摘要（golden 断言用）："seg:pre" / "seg:iso" / "leaf3" / "float3" / "group9[...]"
function sig(steps) {
  return steps.map((s) =>
    s.t === "seg" ? `seg(${s.key.split(":").slice(-1)[0] === "pre" || s.key.includes(":pre") ? "pre" : "iso"},${s.mode},${s.opacity})`
    : s.t === "leaf" ? `leaf${s.id}${s.clipBaseId !== null ? `^${s.clipBaseId}` : ""}`
    : s.t === "float" ? `float${s.id}`
    : `group${s.id}[${sig(s.body)}]`).join(" ");
}

describe("render-plan · 干净帧 / prefix", () => {
  it("updated=∅ + bg → 整树一个 prefix 段（bg 烤入），rootBgLive=false", () => {
    const p = buildPlan([L(1), L(2, { mode: "multiply" }), L(3)], new Set(), "checker");
    eq(sig(p.rootSteps), "seg(pre,source-over,1)", "单段");
    assert(!p.rootBgLive, "bg 已烤入段");
    eq(p.builds.size, 1, "一个建段");
    const b = [...p.builds.values()][0];
    assert(b.withBg && b.steps.length === 3, "prefix 含 bg + 3 叶（multiply 也能并进 prefix）");
    eq(p.liveLeaves.size, 0, "无 live 叶");
  });

  it("updated 中间层：下方全并 prefix（任意 mode）、自身 live、上方 source-over 并 iso", () => {
    const p = buildPlan([L(1, { mode: "multiply" }), L(2), L(3), L(4), L(5)], new Set([3]), "color");
    eq(sig(p.rootSteps), "seg(pre,source-over,1) leaf3 seg(iso,source-over,1)", "三段式");
    assert([...p.liveLeaves].join() === "3", "live 只有 3");
    const iso = [...p.builds.values()].find((b) => !b.withBg);
    eq(iso.members.join(), "4,5", "iso 段成员 4,5");
  });

  it("bg 有但最底层就是 updated → 无 prefix 段，rootBgLive=true", () => {
    const p = buildPlan([L(1), L(2)], new Set([1]), "checker");
    eq(sig(p.rootSteps), "leaf1 leaf2", "1 live；2 单叶不值得成段");
    assert(p.rootBgLive, "bg 每帧自画");
  });

  it("bg=none 时单个静止叶不成段（直画）；两个以上才并", () => {
    const p1 = buildPlan([L(1), L(2, { overlay: true })], new Set(), "none");
    eq(sig(p1.rootSteps), "leaf1 leaf2", "单静止叶直画");
    const p2 = buildPlan([L(1), L(2), L(3, { overlay: true })], new Set(), "none");
    eq(sig(p2.rootSteps), "seg(pre,source-over,1) leaf3", "两叶并 prefix");
  });
});

describe("render-plan · 静止 unit 的可并性", () => {
  it("上方静止 run 里非 source-over 叶断开 run、自己直画", () => {
    const p = buildPlan([L(1, { overlay: true }), L(2), L(3), L(4, { mode: "multiply" }), L(5), L(6)], new Set(), "none");
    eq(sig(p.rootSteps), "leaf1 seg(iso,source-over,1) leaf4 seg(iso,source-over,1)", "multiply 断 run 且直画");
  });

  it("静止非 source-over 隔离组 → children 自成 iso 段，draw 带组参数", () => {
    const p = buildPlan([L(1, { overlay: true }), G(9, [L(2), L(3)], { mode: "multiply", opacity: 0.5 })], new Set(), "none");
    eq(sig(p.rootSteps), "leaf1 seg(iso,multiply,0.5)", "组段带 unitMode/opacity");
    const seg = [...p.builds.values()][0];
    eq(seg.members.join(), "2,3", "段成员 = 组内叶");
  });

  it("静止 source-over 隔离组（opacity<1 逼隔离）可并进相邻 run", () => {
    const p = buildPlan([L(1, { overlay: true }), L(2), G(9, [L(3)], { mode: "source-over", opacity: 0.5 }), L(4)], new Set(), "none");
    eq(sig(p.rootSteps), "leaf1 seg(iso,source-over,1)", "叶2+组9+叶4 一个 run（source-over 结合律）");
    const seg = [...p.builds.values()][0];
    // 段内组保持 group step 结构（隔离语义在段建造时复现）
    const inner = seg.steps.map((s) => s.t).join();
    eq(inner, "leaf,group,leaf", "段内结构保留");
  });
});

describe("render-plan · pass-through 展开 / 嵌套", () => {
  it("pass-through 组展开进父序列，prefix 跨组界合并", () => {
    const p = buildPlan([L(1), G(9, [L(2), L(3)], { mode: "pass-through" }), L(4, { overlay: true })], new Set(), "none");
    eq(sig(p.rootSteps), "seg(pre,source-over,1) leaf4", "1,2,3 并进 prefix");
    eq([...p.builds.values()][0].members.join(), "1,2,3", "跨组界成员");
  });

  it("动态隔离组：group step + body 内嵌套分区（组内 prefix）", () => {
    const p = buildPlan(
      [L(1), G(9, [L(2), L(3, { mode: "multiply" }), L(4, { overlay: true }), L(5)], { mode: "source-over", opacity: 0.9 })],
      new Set(), "none",
    );
    eq(sig(p.rootSteps), "leaf1 group9[seg(pre,source-over,1) leaf4 leaf5]", "组内: 2+3 并 prefix、4 live、5 单叶直画");
    assert(p.liveLeaves.has(4) && p.liveLeaves.has(5) && p.liveLeaves.has(1), "live 叶收齐");
  });
});

describe("render-plan · clip", () => {
  it("clip 层带 clipBaseId；基底在段内但被 live clip 层引用 → 基底进 liveLeaves（spec:152 额外驻留）", () => {
    // 1=基底 2=clip(静止) 3=updated；把 1,2 留在 prefix，3 上再放个 clip 到 3 的层 4
    const p = buildPlan([L(1), L(2, { clip: true }), L(3), L(4, { clip: true })], new Set([3]), "none");
    eq(sig(p.rootSteps), "seg(pre,source-over,1) leaf3 leaf4^3", "4 clip 到 3");
    assert(p.liveLeaves.has(3) && p.liveLeaves.has(4), "live: 3,4");
    const pre = [...p.builds.values()][0];
    assert(pre.members.includes(1) && pre.members.includes(2), "prefix 成员 1,2");
  });

  it("clip 基底是 updated → 上方静止 clip 层跟着 dynamic（不进段）", () => {
    const p = buildPlan([L(1), L(2, { clip: true })], new Set([1]), "none");
    eq(sig(p.rootSteps), "leaf1 leaf2^1", "都 live");
    assert(p.builds.size === 0, "无段");
    assert(p.liveLeaves.has(1) && p.liveLeaves.has(2), "基底+clip 层都 live");
  });

  it("clip 无基底：叶不画、float 仍画；组整个跳过", () => {
    const p = buildPlan(
      [L(1, { hasContent: false, mode: "source-over" }), L(2, { clip: true, float: true }), G(9, [L(3)], { clip: true, mode: "multiply" })],
      new Set(), "none",
    );
    // 1 空层非 clip 不算基底（hasContent=false）→ 2 clipNoBase：叶不画、float 画；组 9 clipNoBase 跳过
    eq(sig(p.rootSteps), "leaf1 float2", "clipNoBase 语义");
  });

  it("段内 clip 链共基底（clip 语义进段建造）", () => {
    const p = buildPlan([L(1), L(2, { clip: true }), L(3, { clip: true }), L(9, { overlay: true })], new Set(), "none");
    const pre = [...p.builds.values()][0];
    const clipIds = pre.steps.map((s) => s.clipBaseId).join();
    eq(clipIds, ",1,1", "2、3 都 clip 到 1");
  });
});

describe("render-plan · float / 多 updated / key 稳定性", () => {
  it("float 恒动态：锚叶 live + float step 紧随；clip 浮层基底联动", () => {
    const p = buildPlan([L(1, { float: true }), L(2, { clip: true, float: true })], new Set([1, 2]), "none");
    eq(sig(p.rootSteps), "leaf1 float1 leaf2^1 float2", "叶+float 成对，2 clip 到 1");
  });

  it("多 updated 兄弟（live2D 前瞻）：各自 live，夹缝静止 run 各自成段", () => {
    const p = buildPlan([L(1), L(2), L(3), L(4), L(5), L(6), L(7)], new Set([3, 6]), "color");
    eq(sig(p.rootSteps), "seg(pre,source-over,1) leaf3 seg(iso,source-over,1) leaf6 leaf7", "prefix+live+iso+live+尾单叶");
  });

  it("同输入 key 稳定；updated 变化 → 分区/key 变", () => {
    const nodes = [L(1), L(2), L(3), L(4)];
    const a = buildPlan(nodes, new Set([3]), "color");
    const b = buildPlan(nodes, new Set([3]), "color");
    eq([...a.cacheKeys].join(), [...b.cacheKeys].join(), "同输入同 key");
    const c = buildPlan(nodes, new Set([2]), "color");
    assert([...c.cacheKeys].join() !== [...a.cacheKeys].join(), "updated 变 → key 变");
    // 一次描边内（updated 不变）多次重建 → 段命中靠 key 相等
    assert(a.builds.get([...a.cacheKeys][0]) !== undefined, "builds 覆盖每个 key");
  });

  it("不可见节点跳过；overlay 锚叶 dynamic", () => {
    const p = buildPlan([L(1), L(2, { visible: false }), L(3, { overlay: true }), L(4)], new Set(), "none");
    eq(sig(p.rootSteps), "leaf1 leaf3 leaf4", "2 消失；1、4 单叶直画（无 bg 单叶不成段）");
  });
});
