// CloudProvider 契约测试 —— 钉死当前 WebPaint sync 依赖的安全语义。
// 每条都对应 cloud.js 里一处红线行为；将来 OneDriveProvider 也必须过同一套。
import { describe, it, assert, eq, throwsStatus } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";

const bytes = (s) => new TextEncoder().encode(s);
async function blobText(blob) { return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())); }

describe("upload / If-Match", () => {
  it("全新 upload 返回带 etag 的 item，getItemByPath 找得到", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("v1"), {});
    assert(it1.eTag, "应有 etag");
    eq(it1.size, 2);
    const found = await p.getItemByPath("画.ora");
    eq(found.id, it1.id);
  });

  it("stale eTag → 412（pushSession 的 If-Match 失败路径）", async () => {
    const p = createMockProvider();
    const v1 = await p.upload("画.ora", bytes("v1"), {});
    await p.upload("画.ora", bytes("v2"), {});         // 别处推新版本，etag 变了
    await throwsStatus(() => p.upload("画.ora", bytes("v3"), { eTag: v1.eTag }), 412, "stale etag 应 412");
  });

  it("正确 eTag → 覆盖成功并 bump etag", async () => {
    const p = createMockProvider();
    const v1 = await p.upload("画.ora", bytes("v1"), {});
    const v2 = await p.upload("画.ora", bytes("v2"), { eTag: v1.eTag });
    assert(v2.eTag !== v1.eTag, "etag 应改变");
    eq(await blobText(await p.download(v2.id)), "v2");
  });

  it("conflictBehavior=fail 撞已存在 → 409", async () => {
    const p = createMockProvider();
    await p.upload("画.ora", bytes("v1"), {});
    await throwsStatus(() => p.upload("画.ora", bytes("v2"), { conflictBehavior: "fail" }), 409, "fail 撞名应 409");
  });

  it("replace（默认）首次推 null etag 被接受", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("v1"), { eTag: null });
    assert(it1.id);
  });

  it("嵌套 path 自动建中间文件夹", async () => {
    const p = createMockProvider();
    await p.upload("characters/wall.ora", bytes("x"), {});
    const folder = await p.getItemByPath("characters");
    assert(folder && folder.isFolder, "characters 应被自动建出");
  });
});

describe("download / byte-range", () => {
  it("download 整文件字节往返", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("hello"), {});
    eq(await blobText(await p.download(it1.id)), "hello");
  });

  it("downloadRange(offset=null, n) 取末尾 n 字节（thumb 依赖）", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("ABCDEFGH"), {});
    const buf = await p.downloadRange(it1.id, null, 3);
    eq(new TextDecoder().decode(new Uint8Array(buf)), "FGH");
  });

  it("downloadRange(offset, n) 取中段", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("ABCDEFGH"), {});
    const buf = await p.downloadRange(it1.id, 2, 3);
    eq(new TextDecoder().decode(new Uint8Array(buf)), "CDE");
  });
});

describe("folder ensure", () => {
  it("ensureFolder 逐段建且幂等（返回同一 id）", async () => {
    const p = createMockProvider();
    const id1 = await p.ensureFolder("a/b/c");
    const id2 = await p.ensureFolder("a/b/c");
    eq(id1, id2, "幂等");
    const mid = await p.getItemByPath("a/b");
    assert(mid && mid.isFolder, "中间段也应在");
  });

  it("ensureFolder('') → approot id", async () => {
    const p = createMockProvider();
    eq(await p.ensureFolder(""), await p.getApprootId());
  });
});

describe("trash move（trashCloudSession 形态）", () => {
  it("移到 .trash + 加 [ts] 后缀：离开原 path，出现在 .trash 下", async () => {
    const p = createMockProvider();
    const item = await p.upload("画.ora", bytes("v1"), {});
    const trashId = await p.ensureFolder(".trash");
    const moved = await p.move(item.id, trashId, { newName: "画 [12345].ora", conflictBehavior: "fail" });
    eq(await p.getItemByPath("画.ora"), null, "原位置应空");
    eq(moved.path, ".trash/画 [12345].ora");
    const inTrash = await p.list(".trash");
    eq(inTrash.length, 1);
  });
});

describe("restore 防覆盖（restoreCloudFromTrash 的 (2)(3) 循环依赖）", () => {
  it("移回目标位置撞同名 → 409；改 (2) 重试成功", async () => {
    const p = createMockProvider();
    // 目标位置已有同名占用
    await p.upload("画.ora", bytes("existing"), {});
    // trash 里有一个待恢复
    const trashId = await p.ensureFolder(".trash");
    const ghost = await p._seed(".trash/画 [99].ora", bytes("recovered"));
    const rootId = await p.getApprootId();
    // 第一次撞名
    await throwsStatus(() => p.move(ghost.id, rootId, { newName: "画.ora", conflictBehavior: "fail" }), 409, "撞名应 409");
    // 退一步：(2)
    const ok = await p.move(ghost.id, rootId, { newName: "画 (2).ora", conflictBehavior: "fail" });
    eq(ok.path, "画 (2).ora");
    eq(await blobText(await p.download(ok.id)), "recovered");
    // 原 existing 没被动
    eq(await blobText(await p.download((await p.getItemByPath("画.ora")).id)), "existing");
  });
});

describe("list / delete / rename", () => {
  it("list 只返回直接 children（不递归）", async () => {
    const p = createMockProvider();
    await p.upload("a.ora", bytes("x"), {});
    await p.upload("sub/b.ora", bytes("y"), {});
    const top = await p.list("");
    const names = top.map((i) => i.name).sort();
    eq(JSON.stringify(names), JSON.stringify(["a.ora", "sub"]), "顶层 = a.ora + sub 文件夹");
  });

  it("delete 后 getItemByPath → null", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("画.ora", bytes("x"), {});
    await p.delete(it1.id);
    eq(await p.getItemByPath("画.ora"), null);
  });

  it("delete 文件夹连子树", async () => {
    const p = createMockProvider();
    await p.upload("sub/b.ora", bytes("y"), {});
    const folder = await p.getItemByPath("sub");
    await p.delete(folder.id);
    eq(await p.getItemByPath("sub/b.ora"), null, "子文件应一并删");
  });

  it("rename：旧名失效新名生效", async () => {
    const p = createMockProvider();
    const it1 = await p.upload("旧.ora", bytes("x"), {});
    await p.rename(it1.id, "新.ora");
    eq(await p.getItemByPath("旧.ora"), null);
    assert(await p.getItemByPath("新.ora"), "新名应在");
  });

  it("rename 撞同名 → 409", async () => {
    const p = createMockProvider();
    const a = await p.upload("a.ora", bytes("x"), {});
    await p.upload("b.ora", bytes("y"), {});
    await throwsStatus(() => p.rename(a.id, "b.ora"), 409, "撞名应 409");
  });
});

describe("race hook（slice C 的 race-serialize 测试基建）", () => {
  it("hook 能拦截 mutating 操作并按序放行", async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = createMockProvider({
      hook: async (op) => { if (op === "upload") { order.push("enter"); await gate; order.push("resume"); } },
    });
    const pushP = p.upload("画.ora", bytes("v1"), {});
    order.push("after-call");          // upload 被 hook 挂起，控制权回到这
    release();
    await pushP;
    eq(JSON.stringify(order), JSON.stringify(["enter", "after-call", "resume"]), "hook 应能挂起再放行");
  });
});
