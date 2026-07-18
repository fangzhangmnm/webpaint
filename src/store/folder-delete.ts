// ⚠ store 内部深模块（provider 共享）。app 不 import。
//
// deleteEmptyFolderVia —— 「只删空夹」护栏的**唯一真相**，供各 CloudProvider 实现 `deleteEmptyFolder` 复用。
//   backend（OneDrive/mock）的通用 delete(id) 对文件夹是**无条件递归**删（Graph `DELETE /items/{id}` 连子孙一起进回收站）——
//   危险。故文件夹删除只走本护栏：getItemByPath → 非文件夹拒（程序错，throw）→ list → 抛错=list-failed → 非空=non-empty →
//   证实空才 delete(id, etag)（If-Match folder etag = **best-effort**：child-add 不保证 bump folder eTag，收不紧但零成本）。
//   **绝不 throw 非空/列举失败**——用判别式 status 返回，让上层区分「取消」(non-empty) 与「留队重试」(list-failed)。
//   残留 TOCTOU（list→delete 单 RTT 间被加子文件 → 递归删掉它 → 进 **provider 回收站**可恢复、但非 app `.trash`）：已知、接受。

import type { CloudItem, FolderDeleteResult } from "./types.ts";

export async function deleteEmptyFolderVia(
  getItemByPath: (path: string) => Promise<CloudItem | null>,
  list: (path: string) => Promise<CloudItem[]>,
  deleteById: (id: string, eTag?: string | null) => Promise<void>,
  path: string,
): Promise<FolderDeleteResult> {
  const item = await getItemByPath(path);
  if (!item) return { status: "already-gone" };                 // 云端本就没这夹 = 终态成功（幂等）
  if (!item.isFolder) throw new Error(`不是文件夹，拒绝删除：${path}`);   // 传了文件 path = 调用方 bug，throw
  let children: CloudItem[];
  try { children = await list(path); }
  catch { return { status: "list-failed" }; }                   // 列举失败 = 确认不了空 → **绝不当空放行**（守卫击穿红线）
  if (children.length) return { status: "non-empty" };          // 有内容 → 不删（online 拒、drain 取消）
  await deleteById(item.id, item.eTag);                          // 证实空 → 删（If-Match folder etag best-effort）
  return { status: "deleted" };
}
