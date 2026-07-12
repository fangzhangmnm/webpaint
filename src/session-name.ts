// session-name.ts —— session 名唯一性校验（本地 + 可选云端），rename / saveAs 共用。
// 消 survey rec #4 的「重名校验复制」：原本 session-state.renameCurrentSession 与
// topbar-menu.menuSaveAs 各抄一份 listSessions/listCloud + includes 检查。两者循环结构有意不同
// （rename 把检查包进 withBusy 覆盖空窗；saveAs 在 busy 前查），故只抽**检查本身**，调用点结构不动。

import { store } from "./app-store.ts";

// 名字占用预检（rename / saveAs 共用）——**统一走 store.nameOccupied**（唯一 local+remote 占用检查）。
//   返回 "local" | "cloud" | null。opts.cloud 形参保留仅为调用点签名稳定（store.nameOccupied 自己按在线态决定查不查云）。
export async function sessionNameConflict(name: string, _opts: { cloud?: boolean } = {}): Promise<"local" | "cloud" | null> {
  return store.nameOccupied(name);
}
