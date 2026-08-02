// write-gate —— PaintDoc mutator 的运行时兜底（v0.8.4 · S4「割3」，ADR-0007）。
//
// 第二道网（第一道 = DocView 编译收口）：PaintDoc 每个 mutator 入口 assertDocWrite——
// 不在写窗口内（operator 锁 / component·tx 声明窗口）→ 触发 violation handler。
// 窗口开启者（白名单，全部有名有姓）：
//   - Workpiece._acquireLock/_releaseLock（operator forward/backward 在锁内）
//   - LayerTree（addLayer/duplicateLayer 创建段、treeTx mutate 窗、setActive 焦点写）
//   - doc-ops.runDocTransform（整 doc 几何 tx 信封的 applyFn 段）
//   - session-state 装载/换文档（docWriteWindow 包住 adopt/setActive）
// handler 由组合根 arm（dev 渠道 throw / prod reportError warning 不炸用户）；未 arm（node 测试、
// 组合根之前）= 静默——测试直捅 doc 是合法姿势（引擎级测试），gate 行为自身另有测试武装后验证。
// 计数器可重入（嵌套窗口/锁中锁安全）。本模块零依赖、DOM-free。

let _depth = 0;
let _onViolation: ((what: string) => void) | null = null;

/** 开写窗口（可重入）。务必 try/finally 配对 exitDocWrite。 */
export function enterDocWrite(): void { _depth++; }
export function exitDocWrite(): void { _depth = Math.max(0, _depth - 1); }

/** 便捷包裹：fn 在写窗口内执行。 */
export function docWriteWindow<T>(fn: () => T): T {
  _depth++;
  try { return fn(); } finally { _depth = Math.max(0, _depth - 1); }
}

/** 组合根武装 violation handler（dev throw / prod 上报）。传 null 解除（测试用）。 */
export function armDocWriteGate(onViolation: ((what: string) => void) | null): void {
  _onViolation = onViolation;
}

/** PaintDoc mutator 入口调（doc.ts）。窗口外且已武装 → violation。 */
export function assertDocWrite(what: string): void {
  if (_depth === 0 && _onViolation) _onViolation(what);
}
