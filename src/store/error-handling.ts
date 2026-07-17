// store 内部统一错误上报——深模块唯一的 surface 通道。
//   红线：**store 侧不 console.log**（层层上报只有最终消费者 app 才 log；见 README §7 / error-badge.ts）。
//   装配：create-store 在 createStore() 时 setStoreErrorReporter((err,level)=>ui.reportError(err,level))；
//         深模块 import { reportStoreError } 直接调，不必把 ui 线穿进每个 factory。
//   分级（severity 由 app 侧 ui.reportError 落到具体 UI 面）：
//     "error"   非预期失败 → app 弹顶层 banner
//     "warning" 可疑但非致命 → app 弹 banner
//     "info"    值得让用户知道的瞬态 → app 状态栏
//     "log"     良性 offline/fallback（funnel 但不打扰用户）→ app 仅 console
//   ⚠ 单例 reporter：一个进程里多 store 实例（多 appId）会后者覆盖前者——它们都汇到同一个 app 级 report，可接受。
export type StoreErrorLevel = "error" | "warning" | "info" | "log";

type Reporter = (err: unknown, level: StoreErrorLevel) => void;

let reporter: Reporter | null = null;

/** create-store 装配时注入（把 ui.reportError 接上）。 */
export function setStoreErrorReporter(fn: Reporter): void {
  reporter = fn;
}

/** 深模块上报入口。未装配（如纯 mock 测试未接 ui）→ 静默 no-op（不 throw、不 console）。 */
export function reportStoreError(err: unknown, level: StoreErrorLevel = "error"): void {
  reporter?.(err, level);
}
