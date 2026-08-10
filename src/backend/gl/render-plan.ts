// render-plan —— 渲染树纯规划（S7b；spec: journal/20260721 Architecture.md :123-159）。
// 输入 图层树 + pseudo 标志 + updatedNodes → 输出 pass 步骤表 + 跨帧缓存段（segment）描述。
// **纯逻辑零 GL**（build.sh lint：render/ 不 import gl/）——执行器 gl/render-tree.ts（+ gl/raster-service.ts）消费。
//
// 核心：把「每帧一层一 pass 全量重合成」换成「静止兄弟合并成缓存段，每帧只画 动态层 + 少数段」。
// 分区规则（spec:144-155 的「建议跨帧缓存」落地）：
//   - 每个「fresh 合成层级」（根 / 隔离组 body）的 unit 序列里：
//     · 第一个动态 unit 之下的全部 → **prefix 段**（= 累积器前缀态，任意 mode 都能并；根级含 bg）。
//     · 其上的静止 unit：贪心合并**连续 source-over** 段（clip/opacity 任意——source-over 的
//       结合律使「先合成到透明 buffer 再整段 source-over」逐像素等价；非 source-over 破坏它，
//       因为 blend 要读真实 backdrop）。
//     · 静止非 source-over 叶：单 pass 直采（缓存无收益）。
//     · 静止非 source-over 隔离组：children 合成结果自成一段（iso），画的时候带组的
//       unitMode/opacity/clip —— 段 ≈ 一张合成好的叶。
//   - pass-through 组就地展开进父序列（合成语义本来就是续同一累积器）；clip 基底仍按**原层级**解析。
//   - 动态判定：updated（pseudo 锚点由调用方并入）∪ overlay/float 锚点 ∪ **clip 基底是动态叶的
//     clip 层**（liquify live-sync/surrogate 每帧改基底 tile → 依赖基底 alpha 的 pass 不能进缓存）。
//   - 段内容只在 invalidate（undo/redo/commit → 调用方清缓存）后重建；一次描边内 key 稳定。
//
// mode 约定：调用方**预归一**（未知 mode → "source-over"；组 "pass-through" 保留）——本模块
//   不 import blend 模式表，避免 render/ ↔ gl/ 依赖。

// ---- 输入 ----
export interface PlanLeaf {
  kind: "leaf"; id: number;
  opacity: number; mode: string;          // 预归一（12 blend 之一或 "source-over"）
  clip: boolean; visible: boolean;
  hasContent: boolean;                    // 有像素（clip 基底判定；空层不能当基底）
  float: boolean;                         // 自由变换浮层锚点（floatPass 在其 z 上方）
  overlay: boolean;                       // live 描边 overlay 锚点（烤进本叶 pass）
}
export interface PlanGroup {
  kind: "group"; id: number;
  opacity: number; mode: string;          // 预归一；"pass-through" 保留
  clip: boolean; visible: boolean;
  children: PlanNode[];
}
export type PlanNode = PlanLeaf | PlanGroup;

export type BgKind = "none" | "checker" | "color";

// ---- 输出 ----
export interface LeafStep { t: "leaf"; id: number; mode: string; opacity: number; clipBaseId: number | null; overlay: boolean }
export interface FloatStep { t: "float"; id: number; clipBaseFloatId: number | null }
export interface SegStep { t: "seg"; key: string; mode: string; opacity: number; clipBaseId: number | null }
export interface GroupStep { t: "group"; id: number; mode: string; opacity: number; clipBaseId: number | null; body: PlanStep[] }
export type PlanStep = LeafStep | FloatStep | SegStep | GroupStep;

// 一段怎么现算（cache miss 时执行器照 steps 合成 → 切 tile 入池）。
// members = 段内被采样的全部叶 id（含段内步骤引用的 clip 基底）——coverage 并集 + 建段前要 sync 的叶。
export interface SegBuild { key: string; steps: PlanStep[]; withBg: boolean; members: number[] }

export interface Plan {
  rootSteps: PlanStep[];
  rootBgLive: boolean;                    // true = 执行器每帧自画 bg（没有 prefix 段替它烤住）
  builds: Map<string, SegBuild>;          // key → 建段方法（cacheKeys 的每个 key 都有）
  cacheKeys: Set<string>;                 // 本分区想要的全部段（不在此集的缓存段 = 孤儿，可回收）
  liveLeaves: Set<number>;                // 每帧直接采样的叶（含 live 步骤的 clip 基底）→ 要 sync + pin
}

// ---- 内部：unit = 一个层级序列里的一次「pass 单元」 ----
type Unit =
  | { u: "leaf"; node: PlanLeaf; clipBaseId: number | null; dynamic: boolean }
  | { u: "float"; node: PlanLeaf; clipBaseFloatId: number | null }   // 恒动态
  | { u: "group"; node: PlanGroup; unitMode: string; clipBaseId: number | null; children: Unit[]; dynamic: boolean };

function needsIsolation(g: PlanGroup): boolean {
  return g.mode !== "pass-through" || g.opacity < 1 || g.clip;
}
function groupUnitMode(g: PlanGroup): string {
  return g.mode === "pass-through" ? "source-over" : g.mode;
}

// clip 基底解析（与 gl-compose-plan resolveClipBases 语义逐条对齐；float 叶算有内容）。
function resolveBases(nodes: PlanNode[]): (PlanNode | null)[] {
  const out: (PlanNode | null)[] = new Array(nodes.length).fill(null);
  let base: PlanNode | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.clip && base) { out[i] = base; continue; }
    const hasContent = n.kind === "group" ? n.visible : (n.visible && (n.hasContent || n.float));
    if (!n.clip && hasContent) base = n;
  }
  return out;
}

export function buildPlan(nodes: PlanNode[], updated: Set<number>, bg: BgKind): Plan {
  const builds = new Map<string, SegBuild>();
  const liveLeaves = new Set<number>();

  // 层级序列 → unit 列表（pass-through 展开；clip 按原层级解析后带走）。
  function unitsOf(nodes: PlanNode[]): Unit[] {
    const bases = resolveBases(nodes);
    const out: Unit[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.visible) continue;
      const base = bases[i];
      const clipNoBase = n.clip && !base;
      const clipBaseId = base && base.kind === "leaf" ? base.id : null;
      if (n.kind === "leaf") {
        // clip 无基底 → 叶不画，但浮层仍显（对齐 gl-compositor/_applyNodes + 2D layer-composite）。
        if (!clipNoBase) {
          const dynamic = updated.has(n.id) || n.overlay || n.float
            || (clipBaseId !== null && baseIsDynamic(base as PlanLeaf));
          out.push({ u: "leaf", node: n, clipBaseId, dynamic });
        }
        if (n.float) {
          const cb = n.clip && base && base.kind === "leaf" && base.float ? base.id : null;
          out.push({ u: "float", node: n, clipBaseFloatId: cb });
        }
      } else {
        if (clipNoBase) continue;
        if (!needsIsolation(n)) { out.push(...unitsOf(n.children)); continue; }
        const children = unitsOf(n.children);
        const dynamic = children.some(isDynamic) || (clipBaseId !== null && baseIsDynamic(base as PlanLeaf));
        out.push({ u: "group", node: n, unitMode: groupUnitMode(n), clipBaseId, children, dynamic });
      }
    }
    return out;
  }
  // clip 基底本身是动态叶（updated/overlay/float/surrogate）→ 依赖它 alpha 的 pass 每帧变。
  //   注意 overlay 不改基底 tile（live 描边不进 clip 蒙版，与现行为一致）——只有 updated（tile 真变）算。
  function baseIsDynamic(base: PlanLeaf): boolean {
    return updated.has(base.id) || base.float;
  }
  function isDynamic(u: Unit): boolean { return u.u === "float" || u.dynamic; }

  // unit → 不分段直画的 step（段内 build 也用它）。
  function stepOf(u: Unit): PlanStep {
    if (u.u === "leaf") {
      noteLive(u.node.id, u.clipBaseId);
      return { t: "leaf", id: u.node.id, mode: u.node.mode, opacity: u.node.opacity, clipBaseId: u.clipBaseId, overlay: u.node.overlay };
    }
    if (u.u === "float") { liveLeaves.add(u.node.id); return { t: "float", id: u.node.id, clipBaseFloatId: u.clipBaseFloatId }; }
    noteLive(null, u.clipBaseId);
    return { t: "group", id: u.node.id, mode: u.unitMode, opacity: u.node.opacity, clipBaseId: u.clipBaseId, body: partition(u.children, u.node.id, false) };
  }
  function noteLive(id: number | null, clipBaseId: number | null): void {
    if (id !== null) liveLeaves.add(id);
    if (clipBaseId !== null) liveLeaves.add(clipBaseId);
  }

  // 段内 steps（不走 liveLeaves——段成员单独记 members）+ 成员收集。
  function segStepsOf(units: Unit[], members: Set<number>): PlanStep[] {
    return units.map((u) => {
      if (u.u === "leaf") {
        members.add(u.node.id);
        if (u.clipBaseId !== null) members.add(u.clipBaseId);
        return { t: "leaf", id: u.node.id, mode: u.node.mode, opacity: u.node.opacity, clipBaseId: u.clipBaseId, overlay: false } as PlanStep;
      }
      if (u.u === "float") throw new Error("PLAN_BUG: float unit in segment");   // float 恒动态，不可达
      if (u.clipBaseId !== null) members.add(u.clipBaseId);
      return { t: "group", id: u.node.id, mode: u.unitMode, opacity: u.node.opacity, clipBaseId: u.clipBaseId, body: segStepsOf(u.children, members) } as PlanStep;
    });
  }

  function unitIds(us: Unit[]): string {
    return `${us[0].u === "group" ? us[0].node.id : us[0].node.id}-${us[us.length - 1].u === "group" ? (us[us.length - 1] as { node: PlanGroup }).node.id : (us[us.length - 1] as { node: PlanLeaf }).node.id}`;
  }

  function makeSeg(units: Unit[], parentId: number, kind: "pre" | "iso", withBg: boolean, drawMode: string, drawOpacity: number, drawClipBaseId: number | null): SegStep {
    const key = `s${parentId}:${unitIds(units)}:${kind}${withBg ? `:bg=${bg}` : ""}`;
    if (!builds.has(key)) {
      const members = new Set<number>();
      const steps = segStepsOf(units, members);
      builds.set(key, { key, steps, withBg, members: [...members] });
    }
    return { t: "seg", key, mode: drawMode, opacity: drawOpacity, clipBaseId: drawClipBaseId };
  }

  // 一个 fresh 合成层级（根/隔离组 body）的分区。
  function partition(units: Unit[], parentId: number, isRoot: boolean): PlanStep[] {
    const steps: PlanStep[] = [];
    if (units.length === 0) return steps;
    let i = 0;
    // prefix：第一个动态 unit 之下全并（含 bg，若在根且有 bg）。单 unit 且无 bg 时并段无收益 → 直画。
    let firstDyn = units.findIndex(isDynamic);
    if (firstDyn === -1) firstDyn = units.length;
    const rootWithBg = isRoot && bg !== "none";
    if (firstDyn > 0 && (firstDyn > 1 || rootWithBg)) {
      steps.push(makeSeg(units.slice(0, firstDyn), parentId, "pre", rootWithBg, "source-over", 1, null));
      i = firstDyn;
    }
    for (; i < units.length; i++) {
      const u = units[i];
      if (isDynamic(u)) { steps.push(stepOf(u)); continue; }
      // 静止：贪心收连续 source-over 可并 run。
      if (mergeable(u)) {
        let j = i;
        while (j + 1 < units.length && !isDynamic(units[j + 1]) && mergeable(units[j + 1])) j++;
        if (j > i) { steps.push(makeSeg(units.slice(i, j + 1), parentId, "iso", false, "source-over", 1, null)); i = j; continue; }
      }
      // 单个静止 unit：叶直画；非 source-over 隔离组 → children 自成一段，带组参数画。
      if (u.u === "leaf") { steps.push(stepOf(u)); continue; }
      const g = u as Extract<Unit, { u: "group" }>;
      steps.push(makeSeg(g.children, g.node.id, "iso", false, g.unitMode, g.node.opacity, g.clipBaseId));
    }
    return steps;
  }
  // 可并进 source-over run：source-over 且（叶 无 overlay——overlay 恒动态不会到这）。
  //   clip/opacity 任意（见文件头结合律论证）。
  function mergeable(u: Unit): boolean {
    if (u.u === "float") return false;
    return (u.u === "leaf" ? u.node.mode : u.unitMode) === "source-over";
  }

  const rootUnits = unitsOf(nodes);
  const rootSteps = partition(rootUnits, -1, true);
  const rootBgLive = bg !== "none" && !rootSteps.some((s) => s.t === "seg" && builds.get(s.key)!.withBg);
  return { rootSteps, rootBgLive, builds, cacheKeys: new Set(builds.keys()), liveLeaves };
}
