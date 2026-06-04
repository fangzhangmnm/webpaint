// OneDriveProvider 适配验收：OneDriveProvider(graphFromProvider(mock)) 应满足 CloudProvider 契约
// （≈ 恒等还原）。真 graph.js 与 graphFromProvider 同表面，故这等价于验真适配正确。
import { describe, it, assert, eq, throwsStatus } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { graphToCloudProvider } from "../src/store/onedrive-provider.js";
import { graphFromProvider } from "./helpers.mjs";

const bytes = (s) => new TextEncoder().encode(s);
const txt = async (blob) => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));

// 真 graph 形态 = graphFromProvider(clean mock)；OneDriveProvider 把它翻回 clean provider。
function odp() {
  const mock = createMockProvider();
  return { mock, p: graphToCloudProvider(graphFromProvider(mock)) };
}

describe("OneDriveProvider 适配", () => {
  it("upload → CloudItem(有 eTag)，getItemByPath 翻回", async () => {
    const { p } = odp();
    const it = await p.upload("a.ora", bytes("v1"), {});
    assert(it.eTag && it.id);
    eq(it.isFolder, false);
    eq((await p.getItemByPath("a.ora")).id, it.id);
  });

  it("stale eTag → 412（透传 graph 的 status）", async () => {
    const { p } = odp();
    const v1 = await p.upload("a.ora", bytes("v1"), {});
    await p.upload("a.ora", bytes("v2"), {});
    await throwsStatus(() => p.upload("a.ora", bytes("v3"), { eTag: v1.eTag }), 412);
  });

  it("conflictBehavior=fail 撞名 → 409", async () => {
    const { p } = odp();
    await p.upload("a.ora", bytes("v1"), {});
    await throwsStatus(() => p.upload("a.ora", bytes("v2"), { conflictBehavior: "fail" }), 409);
  });

  it("download 往返", async () => {
    const { p } = odp();
    const it = await p.upload("a.ora", bytes("hello"), {});
    eq(await txt(await p.download(it.id)), "hello");
  });

  it("downloadRange 末尾 N 字节", async () => {
    const { p } = odp();
    const it = await p.upload("a.ora", bytes("ABCDEFGH"), {});
    eq(new TextDecoder().decode(new Uint8Array(await p.downloadRange(it.id, null, 3))), "FGH");
  });

  it("ensureFolder + list 的 folder isFolder=true", async () => {
    const { p } = odp();
    await p.upload("sub/x.ora", bytes("y"), {});
    const top = await p.list("");
    const sub = top.find((i) => i.name === "sub");
    assert(sub && sub.isFolder, "sub 应 isFolder=true");
    const file = top.find((i) => i.name === "x.ora" || i.name === "sub");
    assert(file);
  });

  it("move 到 .trash + rename + delete", async () => {
    const { mock, p } = odp();
    const it = await p.upload("a.ora", bytes("v1"), {});
    const trash = await p.ensureFolder(".trash");
    const moved = await p.move(it.id, trash, { newName: "a [1].ora", conflictBehavior: "fail" });
    eq(moved.path, ".trash/a [1].ora");
    eq(await p.getItemByPath("a.ora"), null);
    await p.delete(moved.id);
    eq((await p.list(".trash")).length, 0);
  });

  it("getItemByPath 不存在 → null", async () => {
    const { p } = odp();
    eq(await p.getItemByPath("无"), null);
  });
});
