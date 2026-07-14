// 职责（单一）：boot 期的 **localStorage 快照** —— 只有两个键，`webpaint.boot.theme` / `webpaint.boot.lang`。
//
// 为什么必须存在（v409；别再当成"违反了无 localStorage 镜像"而删掉）：
//   设置的 SSoT 是 collection（IDB）。但有两个值在 IDB 就绪**之前**就要用，而 IDB 是异步的：
//   · **theme** —— index.html `<head>` 里的同步 guard 要在**首帧之前**贴上 `data-theme`。
//     pre-paint 同步读只有 localStorage 能做到。不贴 → 夜间用户每次冷启动首帧闪白。
//     （v406 迁 collection 时把 LS 写没了、guard 却留着读 `webpaint.theme` → 该键零写者 → guard 静默失效。
//      这就是 v409 之前的 FOUC 回归；await 修不了它，因为闪白发生在 bundle 求值之前。）
//   · **lang** —— i18n 的 `t()` 在模块 eval 期就被读，`_lang` 一经解析即锁死（reload 制）。
//     v406-v408 靠 app.ts 的 TLA 门（`await initPreferences()`）保证 eval 期 lang 就绪；
//     有了快照就不需要那道门了（v409 拆掉，见 app.ts）。
//
// 纪律（三条，破一条就退化成双 SSoT）：
//   1. **单向只写**：SSoT 恒为 collection。快照只在 collection 值确定后被覆写，绝不反向喂回 collection。
//   2. **只读一次**：只在 boot 期（guard / eval 期 lang 解析）读。之后一律读 collection。
//   3. **只有这两个键**。别加第三个 —— 其余设置的消费方 `await prefsReady` 拿真值即可（app.ts 的 fixup 相）。
//      每加一个键就多一份要对账的镜像，那正是 v406 想消灭的东西。
//
// 对账（collection hydrate/reconcile 之后，见 theme.ts / i18n）：先更新快照 → lang 不对就 reload、theme 不对就地换。
//   顺序不能反：先写快照再 reload，否则 reload 后 eval 期又读到旧快照 → 死循环。

const KEYS = {
  theme: "webpaint.boot.theme",
  lang: "webpaint.boot.lang",
} as const;
export type BootSnapshotKey = keyof typeof KEYS;

// 读快照。无值 / localStorage 不可用（隐私模式、禁 cookie）→ null，调用方回落自己的 default。
export function readBootSnapshot(k: BootSnapshotKey): string | null {
  try { return localStorage.getItem(KEYS[k]); } catch { return null; }
}

// 写快照。传 null = 清（如 lang 回到"跟系统"）。localStorage 不可用 → 静默 no-op（只丢首帧优化，不丢数据：SSoT 在 IDB）。
export function writeBootSnapshot(k: BootSnapshotKey, v: string | null): void {
  try { if (v == null || v === "") localStorage.removeItem(KEYS[k]); else localStorage.setItem(KEYS[k], v); } catch { /* 隐私模式 */ }
}
