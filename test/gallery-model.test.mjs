// Gallery 路径代数 + 展示纯函数验收（A2 出生；C3 瘦身：merge/slice/classify 系列已被 store 库收编，
// 锚随迁 store 侧测试——listing/trash-merge/reconcile/store-folder-listing）。纯数据。
import { describe, it, eq, assert } from "./runner.mjs";
import { pathFolder, pathBasename, pathJoin } from "../src/gallery/gallery-path.ts";
import { copyTargetName, uniqueBareName } from "../src/gallery/gallery-model.ts";

describe("gallery-path", () => {
  it("pathFolder", () => { eq(pathFolder("a"), ""); eq(pathFolder("f/a"), "f"); eq(pathFolder("f/g/a"), "f/g"); });
  it("pathBasename", () => { eq(pathBasename("a"), "a"); eq(pathBasename("f/g/a"), "a"); });
  it("pathJoin", () => { eq(pathJoin("", "a"), "a"); eq(pathJoin("f", "a"), "f/a"); eq(pathJoin("f", ""), "f"); });
});

describe("gallery-model · copyTargetName（复制项目目标名）", () => {
  it("首份「<名> 副本」（不带数字）", () => {
    eq(copyTargetName("猫", () => false), "猫 copy");
  });
  it("「副本」已占 → 「副本2」起递增", () => {
    const taken = new Set(["猫 copy", "猫 copy2"]);
    eq(copyTargetName("猫", (n) => taken.has(n)), "猫 copy3");
  });
  it("保持源同一文件夹（path 前缀不变）", () => {
    eq(copyTargetName("插画/猫", () => false), "插画/猫 copy");
    const taken = new Set(["插画/猫 copy"]);
    eq(copyTargetName("插画/猫", (n) => taken.has(n)), "插画/猫 copy2");
  });
  it("复制的复制：「猫 copy」→「猫 copy copy」（node=en；zh 运行时同构为「副本」）", () => {
    eq(copyTargetName("猫 copy", () => false), "猫 copy copy");
  });
  it("taken 同时查本地⊕云端并集（任一占用都跳过）", () => {
    const local = new Set(["猫 copy"]);
    const cloud = new Set(["猫 copy2"]);
    eq(copyTargetName("猫", (n) => local.has(n) || cloud.has(n)), "猫 copy3");
  });
});


// v0.10.4：uniqueBareName——「不静默覆盖旧画」链的 app 侧兜底层（第 1 层=调用方预检、
// 第 3 层=store mode:"new" 首存护栏抛 CloudNameCollisionError，后者 pin 在库仓
// store-folder-listing/cloud-sync 测试；editor-session 的 mode 传递 pin 在 editor-session.test）。
describe("gallery-model · uniqueBareName（撞名后缀兜底）", () => {
  const occupiedSet = (...names) => async (fullName) => names.includes(fullName);

  it("未占用 → 原裸名直用；占用谓词收到的是库全名 X.ora（身份接缝 pin）", async () => {
    const asked = [];
    const name = await uniqueBareName("猫", async (n) => { asked.push(n); return false; });
    eq(name, "猫");
    eq(asked.length, 1); eq(asked[0], "猫.ora", "查占用必须按库全名（sessionFileName），不是裸名");
  });
  it("占用 → 依次试「base 1」「base 2」…取首个空位", async () => {
    eq(await uniqueBareName("猫", occupiedSet("猫.ora")), "猫 1");
    eq(await uniqueBareName("猫", occupiedSet("猫.ora", "猫 1.ora", "猫 2.ora")), "猫 3");
  });
  it("带夹路径整名参与占用检查（孪生 nameOverride 场景：夹A/foo）", async () => {
    eq(await uniqueBareName("夹A/foo", occupiedSet("夹A/foo.ora")), "夹A/foo 1");
  });
  it("恒占用（1+19 个候选全撞）→ 时间戳兜底，绝不返回已占用名", async () => {
    const asked = [];
    const name = await uniqueBareName("X", async (n) => { asked.push(n); return true; });
    eq(asked.length, 20, "base + 19 个后缀候选全试过");
    assert(/^X \d{12,}$/.test(name), `时间戳兜底形状（得到 ${name}）`);
  });
  it("裸名先归一化（sessionBareName）再查占用（v437 教训：查归一名却返原始名 = 身份分叉）", async () => {
    const asked = [];
    const name = await uniqueBareName("  猫  ", async (n) => { asked.push(n); return false; });
    eq(name.includes("  "), false, "返回的是归一化后的裸名");
    eq(asked[0], `${name}.ora`, "查的名和返回的名是同一个身份");
  });
});
