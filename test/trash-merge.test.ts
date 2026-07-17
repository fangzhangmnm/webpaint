import { test, eq, assert } from "./runner.mjs";
import { mergeTrash } from "../src/store/trash-merge.ts";
import type { CloudItem, TrashEntry } from "../src/store/types.ts";

// 造一个云端 trash CloudItem（mergeTrash 只读 .name/.id；其余按类型填占位）。
const ci = (id: string, name: string): CloudItem => ({ id, name, path: `.trash/${name}`, size: 1, eTag: "e", lastModifiedDateTime: 0 });
const le = (trashKey: string, name: string): TrashEntry => ({ trashKey, name });

const STAMP = "20260717120000-abc1234e-dead-beef-cafe-000000000000";   // yyyymmddhhmmss-guid

test("mergeTrash · 纯本地行（cloud 无）→ side=local、localKey 透传、conflictLive=false", () => {
  const out = mergeTrash([le(`trash/${STAMP}:folder/A.ora`, "folder/A.ora")], [], new Set());
  eq(out.length, 1, "一行");
  eq(out[0].side, "local", "本地行");
  eq(out[0].name, "folder/A.ora", "全路径原名");
  eq(out[0].localKey, `trash/${STAMP}:folder/A.ora`, "trashKey 透传");
  eq(out[0].cloudItemId, null, "无云端腿");
  eq(out[0].ts, "20260717120000", "从 trashKey 解出时间戳");
  assert(!out[0].conflictLive, "无 live → 不冲突");
});

test("mergeTrash · 纯云端行 → side=cloud、还原 basename、非加密", () => {
  const out = mergeTrash([], [ci("c1", `A.ora [${STAMP}]`)], new Set());
  eq(out.length, 1, "一行");
  eq(out[0].side, "cloud", "云端行");
  eq(out[0].name, "A.ora", "去 stamp 还原 basename");
  eq(out[0].cloudItemId, "c1", "cloudItemId 透传");
  eq(out[0].localKey, null, "无本地腿");
  assert(!out[0].encrypted, "非加密");
  eq(out[0].ts, "20260717120000", "解出时间戳");
});

test("mergeTrash · 加密云端行（.zip 尾）→ encrypted=true、base 去 .zip", () => {
  const out = mergeTrash([], [ci("c1", `A.ora [${STAMP}].zip`)], new Set());
  eq(out[0].side, "cloud", "云端");
  eq(out[0].name, "A.ora", "base 不含 .zip");
  assert(out[0].encrypted, "加密标志");
});

test("mergeTrash · 同名两端 → 归并成 side=both（一行，两腿都在）", () => {
  const out = mergeTrash([le(`trash/${STAMP}:A.ora`, "A.ora")], [ci("c1", `A.ora [${STAMP}]`)], new Set());
  eq(out.length, 1, "归并成一行（不是两行）");
  eq(out[0].side, "both", "两端");
  eq(out[0].localKey, `trash/${STAMP}:A.ora`, "本地腿");
  eq(out[0].cloudItemId, "c1", "云端腿");
});

test("mergeTrash · conflictLive：本地 trash 有、原名仍活在权威云端 → 标 conflictLive（离线删被 edit-wins 撤销）", () => {
  const live = new Set(["folder/A.ora"]);
  const out = mergeTrash([le(`trash/${STAMP}:folder/A.ora`, "folder/A.ora")], [], live);
  eq(out[0].side, "local", "本地行");
  assert(out[0].conflictLive, "云端还活着 → 两存告警");
});

test("mergeTrash · both 行不误报 conflictLive（云端在 trash 不算活）", () => {
  const live = new Set(["A.ora"]);   // 就算传了同名 live
  const out = mergeTrash([le(`trash/${STAMP}:A.ora`, "A.ora")], [ci("c1", `A.ora [${STAMP}]`)], live);
  eq(out[0].side, "both", "两端");
  assert(!out[0].conflictLive, "both 行的云端是 trash 副本、非 live → 不报冲突");
});

test("mergeTrash · 同名各两条 → 配对两 both，无残留单边", () => {
  const s2 = "20260717130000-abc1234e-dead-beef-cafe-000000000000";
  const out = mergeTrash(
    [le(`trash/${STAMP}:A.ora`, "A.ora"), le(`trash/${s2}:A.ora`, "A.ora")],
    [ci("c1", `A.ora [${STAMP}]`), ci("c2", `A.ora [${s2}]`)],
    new Set(),
  );
  eq(out.length, 2, "两行");
  assert(out.every((r) => r.side === "both"), "都配成 both");
});
