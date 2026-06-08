// Gallery 路径代数 + 文件夹模型验收（A2）。纯数据。
import { describe, it, assert, eq } from "./runner.mjs";
import { pathFolder, pathBasename, pathJoin } from "../src/gallery-path.js";
import { mergeLocalCloud, sliceFolder, folderHasContents, itemTime } from "../src/gallery-model.js";

describe("gallery-path", () => {
  it("pathFolder", () => { eq(pathFolder("a"), ""); eq(pathFolder("f/a"), "f"); eq(pathFolder("f/g/a"), "f/g"); });
  it("pathBasename", () => { eq(pathBasename("a"), "a"); eq(pathBasename("f/g/a"), "a"); });
  it("pathJoin", () => { eq(pathJoin("", "a"), "a"); eq(pathJoin("f", "a"), "f/a"); eq(pathJoin("f", ""), "f"); });
});

describe("gallery-model · mergeLocalCloud", () => {
  it("同名 local+cloud 合一条（cloud 去 .ora）", () => {
    const m = mergeLocalCloud([{ name: "a", updatedAt: 5 }], [{ path: "a.ora", lastModifiedDateTime: "x" }]);
    eq(m.length, 1); eq(m[0].name, "a"); assert(m[0].local && m[0].cloud, "两端都在");
  });
  it("纯本地 / 纯云端各成条", () => {
    const m = mergeLocalCloud([{ name: "a" }], [{ path: "b.ora" }]);
    eq(m.length, 2);
    assert(m.find((e) => e.name === "b").local === null, "b 纯云");
  });
});

describe("gallery-model · mergeLocalCloud by GUID（ADR-0011 身份；数据完整性）", () => {
  const L = (name, guid, t = 1) => ({ name, guid, updatedAt: t });
  const C = (path, guid) => ({ path: path + ".ora", guid, lastModifiedDateTime: "x", id: "i" + path });

  it("GUID 配对：同 GUID 不同名（别设备改名）→ 合一卡、云端名权威、标 renamedFrom", () => {
    const m = mergeLocalCloud([L("猫", "G1")], [C("小猫", "G1")]);
    eq(m.length, 1, "不再幻象两卡");
    eq(m[0].name, "小猫", "云端 path 为权威名");
    eq(m[0].renamedFrom, "猫", "本地旧名待收敛");
    assert(m[0].local && m[0].cloud, "两端都在");
  });
  it("撞名但 GUID 不同 = 两个身份 → 绝不配对（各起一卡）", () => {
    const m = mergeLocalCloud([L("a", "G1")], [C("a", "G2")]);
    eq(m.length, 2, "不同身份不合并");
  });
  it("混合：local 有 GUID + cloud 无 GUID（legacy 云）同名 → 按 name 配对", () => {
    const m = mergeLocalCloud([L("a", "G1")], [{ path: "a.ora" }]);
    eq(m.length, 1); assert(m[0].local && m[0].cloud); eq(m[0].guid, "G1");
  });
  it("混合：local 无 GUID（legacy）+ cloud 有 GUID 同名 → 配对并采纳 GUID", () => {
    const m = mergeLocalCloud([{ name: "a" }], [C("a", "G1")]);
    eq(m.length, 1); eq(m[0].guid, "G1"); assert(m[0].local && m[0].cloud);
  });
  it("两边都无 GUID（全 legacy）→ 退回 name 配对（不回归）", () => {
    const m = mergeLocalCloud([{ name: "a" }], [{ path: "a.ora" }]);
    eq(m.length, 1); assert(m[0].local && m[0].cloud);
  });
  it("GUID 同名同 → 合一、无 renamedFrom", () => {
    const m = mergeLocalCloud([L("a", "G1")], [C("a", "G1")]);
    eq(m.length, 1); assert(!m[0].renamedFrom);
  });
  it("同 GUID 两个云端文件（provider dedup）→ 不丢，第二个另起一卡", () => {
    const m = mergeLocalCloud([L("a", "G1")], [C("a", "G1"), C("a-copy", "G1")]);
    eq(m.length, 2, "第二个云端 dup 不被吞");
  });
});

describe("gallery-model · sliceFolder", () => {
  const items = mergeLocalCloud(
    [{ name: "x", updatedAt: 30 }, { name: "y", updatedAt: 10 }, { name: "f1/a", updatedAt: 20 }, { name: "f2/c", updatedAt: 5 }],
    [],
  );
  it("根层：immediate 子夹（字母序）+ 直属文件（新→旧）", () => {
    const { folderNames, files } = sliceFolder(items, [], "");
    eq(JSON.stringify(folderNames), JSON.stringify(["f1", "f2"]));
    eq(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["x", "y"]));   // 30 > 10
  });
  it("进 f1：只剩 f1 直属文件、无子夹", () => {
    const { folderNames, files } = sliceFolder(items, [], "f1");
    eq(folderNames.length, 0);
    eq(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["f1/a"]));
  });
  it("云端空文件夹也现身（单一真相源）", () => {
    const { folderNames } = sliceFolder(items, ["emptyDir", "f1/onlycloudsub"], "");
    assert(folderNames.includes("emptyDir"), "空云夹出现");
  });
  it("itemTime：本地 updatedAt 优先，否则云端时间", () => {
    eq(itemTime({ local: { updatedAt: 7 }, cloud: null }), 7);
    eq(itemTime({ local: null, cloud: { lastModifiedDateTime: "1970-01-01T00:00:00.010Z" } }), 10);
  });
});

describe("gallery-model · folderHasContents", () => {
  const items = mergeLocalCloud([{ name: "f1/a" }], []);
  it("有 item 以它为 prefix → 非空", () => assert(folderHasContents(items, [], "f1")));
  it("仅云端子夹以它为 prefix → 非空", () => assert(folderHasContents([], ["f2/sub"], "f2")));
  it("都没有 → 空", () => assert(!folderHasContents(items, [], "f9")));
});
