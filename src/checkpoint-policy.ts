// checkpoint（撤销更改 / revert）的**纯策略**：key 怎么拼、哪些时刻封存、加密件怎么处理。
// 纯模块：无 DOM / 无 IDB / 无 store —— 所以能 node 测（IDB 那层进真机批）。
// 落盘在 storage.ts（app 自己的 `weebpaint` 库，不是 store 的库）；编排在 session-state.ts。
//
// 语义（human 拍板 2026-07-18）：
//   · 快照点 = **打开这幅画的那一刻**（从图库点开 / 新建 / 另存为新身份），不是自动定时。
//   · **tab 重开不刷新**：冷启动 restore 不封存 —— 否则用户重开一次 tab，能回退到的"上次打开"
//     就被刷成了现在，revert 变成没用的空操作。
//   · revert 自己也不封存 —— 否则刚回滚掉的状态立刻把快照覆盖了，等于只能 revert 一次。
//   · 永远只留一份（slot 恒 0），但 key 按「多幅画 + 同画多档」设计好，将来加档不用改 key 格式。
//   · 加密作品存**密文容器**字节（明文派生物永不落持久层——红线）。

/** 何时封存 checkpoint。**显式枚举**而不是在 adopt 里埋钩子——因为 revert 也走 adopt，
 *  埋在里面就会「回滚完顺手把快照覆盖掉」。加新入口时来这里加一条，别在深处埋。 */
export type CheckpointTrigger =
  | "gallery-open"    // 从图库点开一幅画 → 封存
  | "new-doc"         // 新建画布（首存之后）→ 封存（revert = 回到空白）
  | "save-as"         // 另存为新身份 → 封存（新身份的"打开态"就是此刻）
  | "boot-restore"    // 冷启动 / tab 重开 → **不**封存
  | "revert";         // 回滚 → **不**封存

const CAPTURE: Record<CheckpointTrigger, boolean> = {
  "gallery-open": true,
  "new-doc": true,
  "save-as": true,
  "boot-restore": false,
  "revert": false,
};

export function shouldCapture(trigger: CheckpointTrigger): boolean {
  return CAPTURE[trigger] === true;
}

/** checkpoint 的 IDB key。fullName = 库身份全名（X.ora），slot 恒 0（结构留多档余地）。
 *  `:` 安全：文件名里的 `:` 被 config.sessionFileName 剥掉了，不会和分隔符打架。 */
export function checkpointKey(fullName: string, slot = 0): string {
  return `${fullName}:${slot}`;
}

/** 一条 checkpoint 记录。bytes = **at-rest 字节**：加密件是密文容器，明文件是明文 ora。 */
export interface CheckpointRecord {
  name: string;        // 库身份全名（X.ora）
  slot: number;
  at: number;          // 封存时刻（epoch ms）——UI 显示「回到约 N 分钟前」
  bytes: Blob;
  encrypted: boolean;  // bytes 是不是密文容器（读回时决定要不要解壳）
}

/** 显示用：距今多少分钟（至少 1，避免「回到 0 分钟前」这种废话）。 */
export function checkpointAgeMinutes(at: number, now: number): number {
  return Math.max(1, Math.round((now - at) / 60000));
}

