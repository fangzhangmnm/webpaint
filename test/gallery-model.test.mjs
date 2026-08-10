// Gallery 路径代数 + 展示纯函数验收（A2 出生；C3 瘦身：merge/slice/classify 系列已被 store 库收编，
// 锚随迁 store 侧测试——listing/trash-merge/reconcile/store-folder-listing）。纯数据。
import { describe, it, eq } from "./runner.mjs";
import { pathFolder, pathBasename, pathJoin } from "../src/gallery/gallery-path.ts";
import { copyTargetName } from "../src/gallery/gallery-model.ts";

describe("gallery-path", () => {
  it("pathFolder", () => { eq(pathFolder("a"), ""); eq(pathFolder("f/a"), "f"); eq(pathFolder("f/g/a"), "f/g"); });
  it("pathBasename", () => { eq(pathBasename("a"), "a"); eq(pathBasename("f/g/a"), "a"); });
  it("pathJoin", () => { eq(pathJoin("", "a"), "a"); eq(pathJoin("f", "a"), "f/a"); eq(pathJoin("f", ""), "f"); });
});

describe("gallery-model · copyTargetName（复制项目目标名）", () => {
  it("首份「<名> 副本」（不带数字）", () => {
    eq(copyTargetName("猫", () => false), "猫 副本");
  });
  it("「副本」已占 → 「副本2」起递增", () => {
    const taken = new Set(["猫 副本", "猫 副本2"]);
    eq(copyTargetName("猫", (n) => taken.has(n)), "猫 副本3");
  });
  it("保持源同一文件夹（path 前缀不变）", () => {
    eq(copyTargetName("插画/猫", () => false), "插画/猫 副本");
    const taken = new Set(["插画/猫 副本"]);
    eq(copyTargetName("插画/猫", (n) => taken.has(n)), "插画/猫 副本2");
  });
  it("复制的复制：「猫 副本」→「猫 副本 副本」", () => {
    eq(copyTargetName("猫 副本", () => false), "猫 副本 副本");
  });
  it("taken 同时查本地⊕云端并集（任一占用都跳过）", () => {
    const local = new Set(["猫 副本"]);
    const cloud = new Set(["猫 副本2"]);
    eq(copyTargetName("猫", (n) => local.has(n) || cloud.has(n)), "猫 副本3");
  });
});

