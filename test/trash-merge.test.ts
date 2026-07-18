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

// ── deleteEventId 精确配对（v415 修 purge 误配）──────────────────────────────────────────────
// 旧实现按「时间戳排序后按下标」配对，同名多次删除时会把无关的两条腿配成一行 both →
//   彻底删除会一次 purge 掉两个不相干的文件（UI 还只说删了一件），restore 则张冠李戴。
const ID_A = "20260717120000-aaaa1111-0000-0000-0000-000000000000";
const ID_B = "20260718090000-bbbb2222-0000-0000-0000-000000000000";

test("[配对] 单腿交叉（本地只有事件A、云端只有事件B）→ 绝不配成 both", () => {
  // 真实场景：离线删 A（只落本地腿）→ 之后在线删「重建的同名文件」（只落云腿）。
  const out = mergeTrash([le(`trash/${ID_A}:A.ora`, "A.ora")], [ci("c-B", `A.ora [${ID_B}]`)], new Set());
  eq(out.length, 2, "★两次独立删除 = 两行，绝不合并");
  const local = out.find((r) => r.side === "local")!;
  const cloud = out.find((r) => r.side === "cloud")!;
  assert(local && cloud, "一行本地、一行云端");
  eq(local.cloudItemId, null, "★本地行不得挂上别人的 cloudItemId（否则 purge 连删两个）");
  eq(cloud.localKey, null, "★云端行不得挂上别人的 trashKey");
});

test("[配对] 同名删两次、两端俱全 → 按 id 各自配对，绝不交叉", () => {
  const out = mergeTrash(
    // 故意打乱顺序：本地先 B 后 A，云端先 A 后 B
    [le(`trash/${ID_B}:A.ora`, "A.ora"), le(`trash/${ID_A}:A.ora`, "A.ora")],
    [ci("c-A", `A.ora [${ID_A}]`), ci("c-B", `A.ora [${ID_B}]`)],
    new Set(),
  );
  eq(out.length, 2, "两行");
  assert(out.every((r) => r.side === "both"), "都配上了");
  const rowA = out.find((r) => r.localKey === `trash/${ID_A}:A.ora`)!;
  const rowB = out.find((r) => r.localKey === `trash/${ID_B}:A.ora`)!;
  eq(rowA.cloudItemId, "c-A", "★事件A 的本地腿配事件A 的云端腿（不看顺序，只看 id）");
  eq(rowB.cloudItemId, "c-B", "★事件B 同理");
});

test("[配对] 无 stamp 的异常条目（手工放进 .trash）→ 各自单边，不瞎配", () => {
  const out = mergeTrash([le("trash/A.ora", "A.ora")], [ci("c1", "A.ora")], new Set());
  eq(out.length, 2, "两边都解不出 id → 不配对，各出一行");
  assert(out.some((r) => r.side === "local") && out.some((r) => r.side === "cloud"), "一本地一云端");
});
