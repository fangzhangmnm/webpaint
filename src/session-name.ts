// session-name.ts —— session 名唯一性校验（本地 + 可选云端），rename / saveAs 共用。
// 消 survey rec #4 的「重名校验复制」：原本 session-state.renameCurrentSession 与
// topbar-menu.menuSaveAs 各抄一份 listSessions/listCloud + includes 检查。两者循环结构有意不同
// （rename 把检查包进 withBusy 覆盖空窗；saveAs 在 busy 前查），故只抽**检查本身**，调用点结构不动。

import { listSessions } from "./session.ts";
import { listCloudSessionsRecursive } from "./app-store.ts";
import { stripSessionExt } from "./config.ts";

// 返回冲突类型 "local" | "cloud" | null。cloud 列举失败不算冲突（best-effort，吞并 warn）。
export async function sessionNameConflict(name: string, { cloud = false }: { cloud?: boolean } = {}): Promise<"local" | "cloud" | null> {
  const localNames = (await listSessions()).map((s: { name: string }) => s.name);
  if (localNames.includes(name)) return "local";
  if (cloud) {
    try {
      const list = await listCloudSessionsRecursive();
      if (list.map((c: { path: string }) => stripSessionExt(c.path)).includes(name)) return "cloud";
    } catch (e) { console.warn("[session-name] cloud list failed:", e); }
  }
  return null;
}
