// ⚠ store 内部深模块。app 不直接 import——经 createStore。
//
// isHidden —— 列举层的「隐藏项」判定（唯一真相）。**末段（basename）以 "." 开头 = 隐藏**：
//   store 自己的安全网夹（`.trash` / `.backup` / `.<appId>` 放 collections/settings）+ 用户任何
//   dotfile / dotfolder 都不进图库列举。测**末段**故 "a/.b" 判隐藏、".x/y" 的 immediate 段 ".x" 也隐藏。
//   listing.ts / reconcile.ts / cloud-sync.ts 共用这一处，任何列举面想露 dot 项都露不出去。
export function isHidden(name: string): boolean {
  if (!name) return false;
  const seg = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return seg.startsWith(".");
}
