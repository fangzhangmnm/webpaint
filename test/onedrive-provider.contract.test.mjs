// OneDriveProvider 适配验收：OneDriveProvider(graphFromProvider(mock)) 应满足 CloudProvider 契约
// （≈ 恒等还原）。真 graph.js 与 graphFromProvider 同表面，故这等价于验真适配正确。
import { describe, it, assert, eq, throwsStatus } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { graphToCloudProvider } from "../src/store/onedrive-provider.ts";
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

// ---- 对抗性：复刻真 graph.js 的「字节敏感」分支（mock provider 太宽容，盖住了这道缝）----
// 真 graph 按 body.size 选 简单 PUT / 分块；分块循环 while(offset<body.size)。
// 喂它 Uint8Array（.size===undefined）→ undefined<=4MB 为 false → 走分块 → while(0<undefined) 零 chunk
// → 只剩 createUploadSession 的 0 字节占位。这正是 2026-06-05 production 的 0B 上传。
function brittleGraph(store) {
  const LIMIT = 4 * 1024 * 1024;
  return {
    uploadFileToApproot: async (path, body /* 真 graph 假设是 Blob */) => {
      if (body.size <= LIMIT) {                                   // 简单路径（只认 .size）
        const buf = new Uint8Array(await body.arrayBuffer());
        store.set(path, buf);
        return { id: path, name: path, eTag: `e:${buf.length}`, size: buf.length, file: {} };
      }
      // 分块路径：body.size 为 undefined 时一个 chunk 都不传；服务端把所有 chunk 拼起来
      let offset = 0, last = null;
      const parts = [];
      while (offset < body.size) {
        const end = Math.min(offset + LIMIT, body.size);
        parts.push(new Uint8Array(await body.slice(offset, end).arrayBuffer()));
        offset = end;
      }
      if (parts.length) {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const buf = new Uint8Array(total);
        let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
        store.set(path, buf);
        last = { id: path, name: path, eTag: `e:${total}`, size: total, file: {} };
      }
      if (!store.has(path)) store.set(path, new Uint8Array(0));   // createUploadSession 的 0 字节占位
      return last;                                                 // 零 chunk → null
    },
  };
}

describe("OneDriveProvider 适配 · 对抗", () => {
  it("[对抗] Uint8Array 上传不得变成 0 字节（修前：graph 收到 .size=undefined → 分块零字节）", async () => {
    const store = new Map();
    const p = graphToCloudProvider(brittleGraph(store));
    const it = await p.upload("a.ora", bytes("hello"), {});      // lib 给的就是 Uint8Array
    eq(store.get("a.ora").length, 5, "必须真传 5 字节，不是 0 字节占位");
    assert(it && it.eTag, "应拿到带 eTag 的真 item，而非 null");
  });

  it("[对抗] 大于 4MB 的 Uint8Array 也走得通分块（.size/.slice 都得在 Blob 上有意义）", async () => {
    const store = new Map();
    const p = graphToCloudProvider(brittleGraph(store));
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    await p.upload("big.ora", big, {});
    eq(store.get("big.ora").length, big.length, "分块路径必须把全部字节传完");
  });
});
