// 职责（单一）：图层树结构变更的**提交信封** runTreeOp —— doc-ops.ts 的 runDocTransform 的树版。
//
// 为什么需要这个模块：像素编辑有 PixelEdit.begin/commit 信封、文档变换有 runDocTransform 信封，
// 唯独树/组操作没有——layers-panel 里六个调用点各自手搓
//   `const before = doc.snapshotTree(); …改树…; history.push({type:"treeStructure", before, after:doc.snapshotTree(), …}); _afterDocChange();`
// 手搓就会漏。缺陷 B（清空图层 undo 恢复出空像素）就是同一类事故的另一个实例：手搓一条 entry、
// 字段名写错，编译期运行期都没人吭声，一直到用户按 Ctrl+Z 才发现画没了。
//
// 信封为**走它的那些 op**（见下"覆盖面"）保证三件手搓时会漏的事：
//   1. **必定入栈**——漏了 = 这一步静默不可撤销。
//   2. **结构变更前先烤定 transient**（applyPendingTransient）：浮层活着时改树，浮层的源层
//      指向会跟着树一起变。这也是从源头再消一次缺陷 D（另一半在 gl-board 的 shouldSyncAll）。
//   3. **守卫不过 = 什么都不发生**——包括**不烤定** transient（guard 先行，见 runTreeOp）。
//      注意区分：`guard` 返 false 是"这次操作根本不会发生"，此刻零副作用；而 `applyFn` 返 false
//      是"守卫过了但变更没成"，那时 transient 已烤定（可接受，因为守卫已判定它本该发生）。
//
// **覆盖面（别把它想得比实际大）**：目前只有 5 个 op 走信封——删组、新建空组、解组、移入组、
//   移出组。**叶**的增删（`_addEmptyLayer` / `_deleteLayer` 的叶分支）、重命名、`setLayerProp`
//   仍是各自手搓、**没有** applyPendingTransient。它们各有自己的 entry 类型（addLayer/removeLayer/
//   renameLayer/setLayerProp），不是 treeStructure，收编进来需要先统一 entry 形状——尚未做。
//
// 注意信封**不管**「叶子离树前强制物化」——那条护栏在模型层（doc.removeLayer / doc.restoreTree，
// 见 doc.materializeDetaching）。必须在那里，因为 treeStructure.redo 自己会调 restoreTree 再次
// detach，根本不经过本模块。UI 层的信封挡不住 undo/redo 路径。

import type { AppContext } from "./app-context.ts";

let editMode: AppContext["editMode"], doc: AppContext["doc"], history: AppContext["history"], setStatus: AppContext["setStatus"];
let _afterDocChange: AppContext["afterDocChange"];

export function initTreeOps(ctx: AppContext) {
  ({ editMode, doc, history, setStatus, afterDocChange: _afterDocChange } = ctx);
}

export interface TreeOpLabels {
  undo: string;      // 撤销这一步时的状态栏文案
  redo: string;      // 重做这一步时的状态栏文案
  status?: string;   // 执行成功后立刻显示的状态栏文案（可省）
}

// 执行一次树结构变更并入栈。applyFn 返回 false = 守卫未过（什么都不入栈）。
// 返回是否真的发生了这次变更。
//
// labels 可以传函数：那样它在 applyFn **之后**才求值——新建组这类 op 要等 addGroup() 返回
// 才知道组名，否则调用方得在入栈后回填 label（丑且容易忘）。
// guard：**在烤定 transient 之前**跑的纯前置检查。返回 false = 这次操作根本不会发生，
//   此时必须原样退出——绝不能已经把用户在制的浮层/调色烤定掉。
//   （v439 曾把 applyPendingTransient 放在守卫之前，于是"对已在根层的图层点移出组"这种无效点击
//     会静默销毁用户正在做的自由变换、还多压一条 entry，且状态栏毫无提示。）
//   调用方请传 doc 侧的 `can*` 纯谓词，别在这里复制模型层的判定逻辑（会漂移）。
export function runTreeOp(
  labels: TreeOpLabels | (() => TreeOpLabels),
  applyFn: () => boolean | void,
  guard?: () => boolean,
): boolean {
  if (guard && !guard()) return false;       // 守卫先行：此刻什么副作用都还没发生
  editMode.applyPendingTransient();          // 结构变更前先烤定浮层/调整预览
  const before = doc.snapshotTree();
  if (applyFn() === false) return false;     // 变更未发生 → 不入栈（before 快照随即被 GC）
  const lb = typeof labels === "function" ? labels() : labels;
  history.push({
    type: "treeStructure",
    before,
    after: doc.snapshotTree(),
    undoStatus: lb.undo,
    redoStatus: lb.redo,
  });
  _afterDocChange();
  if (lb.status) setStatus(lb.status);
  return true;
}
