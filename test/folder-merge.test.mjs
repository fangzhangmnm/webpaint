// Folder shape 合并引擎验收（generic，app-agnostic）。模型见 ADR-0011 §Refinement 2026-06-06/-06b。
// 验：不同 id union 无损 / 同 id LWW by uat / commutative + idempotent /
//     删除=value:null 墓碑，与编辑照 uat-LWW 竞争（删得晚→删掉、编辑得晚→复活）/
//     parseFolderBlob 拒 HTML·截断 / resolveRef id→name 兜底。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  mergeFolders, emptyFolder, isValidFolderEnvelope, parseFolderBlob, resolveRef,
} from "../src/store/folder-merge.ts";

// 规范化：items 按 id 排序后 JSON，用于无视顺序的相等比较（无 trash/resetAt——tombstone 化）。
const norm = (f) => JSON.stringify({
  version: f.version,
  items: [...f.items].sort((a, b) => String(a.id).localeCompare(String(b.id))),
});
const item = (id, uat, extra = {}) => ({ id, uat, name: id, ...extra });
const tomb = (id, uat) => ({ id, uat, value: null });   // 墓碑：value:null = 删除指令
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

  it("commutative：merge(A,B) ≡ merge(B,A)（含 uat 相等的 tiebreak + 墓碑）", () => {
    const A = { ...emptyFolder(), items: [item("a", 10, { v: 1 }), item("x", 5, { v: "L" }), tomb("d", 9)] };
    const B = { ...emptyFolder(), items: [item("b", 12), item("x", 5, { v: "R" }), tomb("d", 7)] };
    eq(norm(mergeFolders(A, B)), norm(mergeFolders(B, A)), "merge 不满足交换律");
  });

  it("idempotent：merge(A,A) ≡ A", () => {
    const A = { version: 2, items: [item("a", 10), item("b", 11), tomb("d", 9)] };
    eq(norm(mergeFolders(A, A)), norm(A));
    eq(norm(mergeFolders(mergeFolders(A, A), A)), norm(A), "两次合并应稳定");
  });

  it("删 vs 编辑：编辑得晚(uat 大) → 复活（值胜过墓碑）", () => {
    const A = { ...emptyFolder(), items: [tomb("x", 10)] };                  // A 删 x@10
    const B = { ...emptyFolder(), items: [item("x", 20, { value: "edited" })] }; // B 在 x@20 编辑
    const m = mergeFolders(A, B);
    eq(m.items.length, 1, "墓碑与值同 id → 一条");
    eq(m.items[0].value, "edited", "编辑得晚 → 值胜（复活）");
  });

  it("删 vs 编辑：删得晚(uat ≥ 编辑) → 墓碑胜（真删；墓碑留 items 照 LWW 传播）", () => {
    const A = { ...emptyFolder(), items: [tomb("x", 20)] };                  // A 删 x@20
    const B = { ...emptyFolder(), items: [item("x", 10, { value: "old" })] }; // B 持旧 x@10
    const m = mergeFolders(A, B);
    eq(m.items.length, 1, "墓碑保留在 items（供跨设备传播删除）");
    eq(m.items[0].value, null, "删得晚 → 墓碑胜");
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
    assert(!isValidFolderEnvelope({ version: 2, items: [{ id: "a" }] }));
  });
});

describe("Folder.resolveRef（id→name 兜底）", () => {
  const items = [item("g1", 1, { name: "勾线笔" }), item("g2", 1, { name: "大润笔" })];
  it("id 命中", () => { eq(resolveRef(items, { id: "g2", name: "x" }).name, "大润笔"); });
  it("id 失败 → name 兜底（跨设备换了 GUID）", () => { eq(resolveRef(items, { id: "gone", name: "勾线笔" }).id, "g1"); });
  it("都不中 → null", () => { eq(resolveRef(items, { id: "gone", name: "无" }), null); });
});
