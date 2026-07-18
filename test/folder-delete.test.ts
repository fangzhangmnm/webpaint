// deleteEmptyFolderVia（provider 共享护栏）：四态 + If-Match 透传 + 递归删绝不发生（非空/list-fail 不 delete）。
import { test, eq, assert } from "./runner.mjs";
import { deleteEmptyFolderVia } from "../src/store/folder-delete.ts";
import type { CloudItem } from "../src/store/types.ts";

const folder = (path: string, eTag = "e1"): CloudItem => ({ id: `id:${path}`, name: path, path, size: 0, eTag, lastModifiedDateTime: 0, isFolder: true });
const fileItem = (path: string): CloudItem => ({ id: `id:${path}`, name: path, path, size: 1, eTag: "e", lastModifiedDateTime: 0, isFolder: false });

test("[folder-delete] 空夹 → deleted（delete 调过，带 If-Match folder etag）", async () => {
  const deleted: Array<{ id: string; etag?: string | null }> = [];
  const r = await deleteEmptyFolderVia(
    async () => folder("F", "ETAG9"),
    async () => [],                                  // 空
    async (id, etag) => { deleted.push({ id, etag }); },
    "F",
  );
  eq(r.status, "deleted");
  eq(deleted.length, 1, "删了一次"); eq(deleted[0].id, "id:F"); eq(deleted[0].etag, "ETAG9", "If-Match 透传 folder etag");
});

test("[folder-delete] 非空夹 → non-empty（**绝不 delete**，杜绝递归误删）", async () => {
  let deleteCalled = false;
  const r = await deleteEmptyFolderVia(
    async () => folder("F"),
    async () => [fileItem("F/child")],               // 有内容
    async () => { deleteCalled = true; },
    "F",
  );
  eq(r.status, "non-empty");
  assert(!deleteCalled, "非空绝不 delete（否则 Graph 递归删掉子孙）");
});

test("[folder-delete] list 抛错 → list-failed（**绝不当空放行**，守卫击穿红线）", async () => {
  let deleteCalled = false;
  const r = await deleteEmptyFolderVia(
    async () => folder("F"),
    async () => { throw new Error("network"); },     // 列举失败
    async () => { deleteCalled = true; },
    "F",
  );
  eq(r.status, "list-failed");
  assert(!deleteCalled, "确认不了空绝不删");
});

test("[folder-delete] 不存在 → already-gone（幂等）", async () => {
  const r = await deleteEmptyFolderVia(async () => null, async () => [], async () => {}, "Nope");
  eq(r.status, "already-gone");
});

test("[folder-delete] 传了文件 path → throw（调用方 bug，非 status）", async () => {
  let threw = false;
  try { await deleteEmptyFolderVia(async () => fileItem("F.ora"), async () => [], async () => {}, "F.ora"); }
  catch { threw = true; }
  assert(threw, "非文件夹 → throw");
});
