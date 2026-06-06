// Folder shape 合并引擎验收（generic，app-agnostic）。模型见 ADR-0011 §Refinement 2026-06-06/-06b。
// 验：不同 id union 无损 / 同 id LWW by uat / commutative + idempotent /
//     删-vs-编辑 edit-wins / resetAt watermark(max-wins, 水位下落) /
//     parseFolderBlob 拒 HTML·截断 / resolveRef id→name 兜底。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  mergeFolders, emptyFolder, isValidFolderEnvelope, parseFolderBlob, resolveRef,
} from "../src/store/folder-merge.js";

// 规范化：items / trash 按 id 排序后 JSON，用于无视顺序的相等比较。
const norm = (f) => JSON.stringify({
  version: f.version,
  resetAt: f.resetAt,
  items: [...f.items].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  trash: [...f.trash].sort((a, b) => String(a.id).localeCompare(String(b.id))),
});
const item = (id, uat, extra = {}) => ({ id, uat, name: id, ...extra });
const ids = (f) => f.items.map((e) => e.id).sort();

describe("Folder.merge", () => {
  it("不同 id → union 无损（改不同 entry 不丢）", () => {
    const A = { ...emptyFolder(), items: [item("a", 10), item("b", 11)] };
    const B = { ...emptyFolder(), items: [item("c", 12)] };
    eq(JSON.stringify(ids(mergeFolders(A, B))), JSON.stringify(["a", "b", "c"]));
  });

  it("同 id 撞 → uat 大的胜（整 entry LWW）", () => {
    const A = { ...emptyFolder(), items: [item("x", 10, { v: "old" })] };
    const B = { ...emptyFolder(), items: [item("x", 20, { v: "new" })] };
    const m = mergeFolders(A, B);
    eq(m.items.length, 1);
    eq(m.items[0].v, "new");
  });

  it("commutative：merge(A,B) ≡ merge(B,A)（含 uat 相等的 tiebreak）", () => {
    const A = { ...emptyFolder(), items: [item("a", 10, { v: 1 }), item("x", 5, { v: "L" })], trash: [{ id: "d", uat: 9 }] };
    const B = { ...emptyFolder(), items: [item("b", 12), item("x", 5, { v: "R" })], trash: [{ id: "d", uat: 7 }] };
    eq(norm(mergeFolders(A, B)), norm(mergeFolders(B, A)), "merge 不满足交换律");
  });

  it("idempotent：merge(A,A) ≡ A", () => {
    const A = { version: 1, resetAt: 0, items: [item("a", 10), item("b", 11)], trash: [{ id: "d", uat: 9 }] };
    eq(norm(mergeFolders(A, A)), norm(A));
    eq(norm(mergeFolders(mergeFolders(A, A), A)), norm(A), "两次合并应稳定");
  });

  it("删 vs 编辑 = edit-wins：删后又编辑 → 复活、trash 记录作废", () => {
    const A = { ...emptyFolder(), trash: [{ id: "x", uat: 10 }] };          // A 删 x@10
    const B = { ...emptyFolder(), items: [item("x", 20, { v: "edited" })] }; // B 在 x@20 编辑
    const m = mergeFolders(A, B);
    eq(m.items.length, 1, "应复活");
    eq(m.items[0].v, "edited");
    eq(m.trash.length, 0, "trash 记录应作废");
  });

  it("删 vs 编辑：删 ≥ 编辑 → 真删、留 trash 记录", () => {
    const A = { ...emptyFolder(), trash: [{ id: "x", uat: 20 }] };          // A 删 x@20
    const B = { ...emptyFolder(), items: [item("x", 10)] };                  // B 持旧 x@10
    const m = mergeFolders(A, B);
    eq(m.items.length, 0, "应真删");
    eq(m.trash.length, 1, "应留 trash 记录（缺席≠删除）");
  });

  it("resetAt watermark：max-wins，水位下的 entry/trash 一律落", () => {
    const A = { version: 1, resetAt: 100, items: [item("new", 150)], trash: [] };
    const B = { version: 1, resetAt: 0, items: [item("old", 50), item("keep", 200)], trash: [{ id: "td", uat: 30 }] };
    const m = mergeFolders(A, B);
    eq(m.resetAt, 100, "resetAt 应 max-wins");
    eq(JSON.stringify(ids(m)), JSON.stringify(["keep", "new"]), "old(50)/td(30) 应被水位清掉");
    eq(m.trash.length, 0, "水位下的 trash 记录应清");
  });

  it("字段级 override（书签集并集那种）走 opts.resolve", () => {
    const A = { ...emptyFolder(), items: [{ id: "bk", uat: 10, set: ["p1"] }] };
    const B = { ...emptyFolder(), items: [{ id: "bk", uat: 20, set: ["p2"] }] };
    const unionResolve = (x, y) => ({ ...y, set: [...new Set([...(x.set || []), ...(y.set || [])])] });
    const m = mergeFolders(A, B, { resolve: unionResolve });
    eq(JSON.stringify([...m.items[0].set].sort()), JSON.stringify(["p1", "p2"]));
  });
});

describe("Folder.parseFolderBlob（伪在线防线）", () => {
  const valid = JSON.stringify(emptyFolder());
  it("合法 envelope → 解出", () => { assert(parseFolderBlob(valid), "合法应解出"); });
  it("captive-portal HTML → null", () => { eq(parseFolderBlob("<!DOCTYPE html><html>login</html>"), null); });
  it("截断 / 乱字节 → null", () => { eq(parseFolderBlob('{"version":1,"items":['), null); });
  it("是 JSON 但不是 envelope → null", () => { eq(parseFolderBlob('{"foo":1}'), null); });
  it("envelope 校验：items 缺 uat → 不合法", () => {
    assert(!isValidFolderEnvelope({ version: 1, resetAt: 0, trash: [], items: [{ id: "a" }] }));
  });
});

describe("Folder.resolveRef（id→name 兜底）", () => {
  const items = [item("g1", 1, { name: "勾线笔" }), item("g2", 1, { name: "大润笔" })];
  it("id 命中", () => { eq(resolveRef(items, { id: "g2", name: "x" }).name, "大润笔"); });
  it("id 失败 → name 兜底（跨设备换了 GUID）", () => { eq(resolveRef(items, { id: "gone", name: "勾线笔" }).id, "g1"); });
  it("都不中 → null", () => { eq(resolveRef(items, { id: "gone", name: "无" }), null); });
});
