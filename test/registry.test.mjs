// Contribution 注册表原语验收（candidate 2）。
// registry 是新深模块的接缝：register/get/list/has/onRegistered。filter 与 exporter 都建在其上。
import { describe, it, assert, eq } from "./runner.mjs";
import { makeRegistry } from "../src/registry.ts";

describe("registry · makeRegistry", () => {
  it("register/get/list/has 基本路径", () => {
    const reg = makeRegistry({ name: "t" });
    eq(reg.list().length, 0, "初始为空");
    eq(reg.get("a"), null, "缺失返 null");
    eq(reg.has("a"), false);
    const a = { id: "a", v: 1 };
    eq(reg.register(a), a, "register 返回原项（链式友好）");
    assert(reg.has("a"));
    eq(reg.get("a"), a, "get 返回同一引用");
    eq(reg.list().length, 1);
  });

  it("同 id 重复注册 = 覆盖（热替换插件友好），list 不增长", () => {
    const reg = makeRegistry();
    reg.register({ id: "x", n: 1 });
    reg.register({ id: "x", n: 2 });
    eq(reg.list().length, 1, "仍只有 1 项");
    eq(reg.get("x").n, 2, "后者覆盖前者");
  });

  it("缺 id 抛错，错误信息含 registry 名", () => {
    const reg = makeRegistry({ name: "exporter" });
    let msg = "";
    try { reg.register({ nope: 1 }); } catch (e) { msg = e.message; }
    assert(msg.includes("exporter"), `错误应含名字: ${msg}`);
    assert(msg.includes("id"), "错误应提到 idKey");
  });

  it("自定义 idKey + static getter 形式（如 FilterClass.id 是字段，函数 id 也支持）", () => {
    const reg = makeRegistry({ idKey: "key" });
    reg.register({ key: "k1" });
    eq(reg.get("k1").key, "k1");
    // 函数式 id（idOf 会 call 它）
    const fnReg = makeRegistry({ idKey: "id" });
    fnReg.register({ id() { return "computed"; } });
    eq(fnReg.has("computed"), true, "函数式 id 被求值");
  });

  it("onRegistered 在每次注册时回调，返回取消订阅", () => {
    const reg = makeRegistry();
    const seen = [];
    const off = reg.onRegistered((item) => seen.push(item.id));
    reg.register({ id: "a" });
    reg.register({ id: "b" });
    eq(seen.join(","), "a,b", "两次注册都回调");
    off();
    reg.register({ id: "c" });
    eq(seen.join(","), "a,b", "取消订阅后不再回调");
  });

  it("一个 listener 抛错不影响其他 listener / 注册本身", () => {
    const reg = makeRegistry();
    const seen = [];
    reg.onRegistered(() => { throw new Error("boom"); });
    reg.onRegistered((it) => seen.push(it.id));
    const r = reg.register({ id: "ok" });
    eq(r.id, "ok", "注册仍成功");
    eq(seen.join(","), "ok", "健康 listener 仍被调");
  });

  it("两实例隔离（filter ⟂ exporter 不串）", () => {
    const a = makeRegistry({ name: "filter" });
    const b = makeRegistry({ name: "exporter" });
    a.register({ id: "shared" });
    eq(a.has("shared"), true);
    eq(b.has("shared"), false, "另一实例不可见");
  });
});
