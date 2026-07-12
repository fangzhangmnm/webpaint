// session-name.ts —— session 名唯一性校验（本地 + 可选云端），rename / saveAs 共用。
// 消 survey rec #4 的「重名校验复制」：原本 session-state.renameCurrentSession 与
// topbar-menu.menuSaveAs 各抄一份 listSessions/listCloud + includes 检查。两者循环结构有意不同
// （rename 把检查包进 withBusy 覆盖空窗；saveAs 在 busy 前查），故只抽**检查本身**，调用点结构不动。

import { listSessions } from "./session.ts";

// 本地重名预检（app 合法知道本地全量 session）。**云端碰撞不在这里查**——网盘模型下 app 原则上不知别夹内容，
//   云端占用由 store 的 rename/saveAs 目标护栏内化检测（撞名抛 CloudNameCollisionError，调用方 catch 循环重问）。
//   保留 opts.cloud 形参仅为调用点签名稳定（本函数忽略它）；返回 "local" | null。
export async function sessionNameConflict(name: string, _opts: { cloud?: boolean } = {}): Promise<"local" | null> {
  const localNames = (await listSessions()).map((s: { name: string }) => s.name);
  return localNames.includes(name) ? "local" : null;
}
