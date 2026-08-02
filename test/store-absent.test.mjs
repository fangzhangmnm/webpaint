// v0.8.7 · B 骑士行为锁：store 缺席变体（null-store / 内存 collection / dormant auth）。
// 胜利条件：store 缺席时 app 仍可 boot（子进程整段 boot smoke）、collection 内存可编辑、
// gallery 空态不挂起、file 面全 no-op 不炸。null-store cast 的 drift 由这里逐成员点名。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, eq } from "./runner.mjs";
import { createNullStore, createMemoryCollection, createDormantAuth } from "../src/store-absent.ts";

describe("store-absent · 内存 collection", () => {
  it("getInitData seed + get/set/entries/tombstone/onChange", async () => {
    const c = createMemoryCollection({ getInitData: () => [{ id: "a", value: 1 }, { id: "b", value: 2 }] });
    await c.init();
    eq(c.getItem("a"), 1, "seed 可读");
    eq(c.keys().length, 2, "两条");
    let hits = 0;
    const off = c.onChange(() => hits++);
    c.setItem("a", 9);
    eq(c.getItem("a"), 9, "内存可编辑");
    eq(hits, 1, "整库 onChange 触发");
    let keyHits = 0;
    c.onChange("b", () => keyHits++);
    c.deleteItem("b");
    eq(c.getItem("b", "默认"), "默认", "墓碑读回默认");
    eq(c.keys().length, 1, "墓碑不进 keys");
    eq(keyHits, 1, "单 key onChange 触发");
    off();
    c.setItem("a", 10);
    eq(hits, 2 - 1 + 1, "退订后不再累计（仅剩之前那次+退订前）");   // hits 停在 2：setItem(a,9)+deleteItem(b)
    eq((await c.reconcileWithRemote()).status, "offline", "reconcile 报 offline");
    eq((await c.flushLocal()).ok, true, "flushLocal ok");
  });
});

describe("store-absent · null-store 消费面点名", () => {
  it("file()/files/encryption/collection 全成员 no-op 不炸", async () => {
    const s = createNullStore();
    const f = s.file("X.ora", { isZip: true, mode: "existing" });
    eq(await f.open(), null, "open null");
    eq((await f.save(new Blob(["x"]))).pushed, false, "save 不推");
    eq((await f.tryMove("Y.ora")).ok, false, "tryMove 拒");
    eq(typeof (await f.delete()).status, "string", "delete 结果式");
    eq(await f.isEncrypted(), false, "无加密");
    eq(await f.verifyPassword("x"), false, "验密 false");
    eq((await f.pullIfClean()).status, "offline", "快进 offline");
    eq(await f.getPeek(), null, "peek null");
    await f.keepOffline(); f.isKeptOffline();
    await f.reupload(); await f.offload(); await f.encrypt(); await f.decrypt();
    // files 命名空间
    let snap = null;
    s.files.watchFolder("", (v) => { snap = v; });
    await new Promise((r) => setTimeout(r, 0));
    assert(snap && snap.items.length === 0, "watchFolder 立即空帧（gallery 空态不挂起）");
    eq(await s.files.nameOccupied("X.ora"), false, "nameOccupied false");
    eq((await s.files.usage()).count, 0, "usage 零");
    eq((await s.files.listTrash()).length, 0, "trash 空");
    eq((await s.files.listBackup()).length, 0, "backup 空");
    await s.files.drainOfflineQueue(); await s.files.ensureFolder("a");
    await s.files.newFolder("a"); await s.files.deleteFolder("a");
    await s.files.restoreTrash("x"); await s.files.purgeTrash("x");
    await s.files.emptyTrash(); await s.files.emptyBackup(); await s.files.reconcileAll();
    // encryption 面
    eq(await s.encryption.isEncryptedBlob(new Blob(["x"])), false, "isEncryptedBlob false");
    eq(await s.encryption.tryDecryptEncryptedBlob(new Blob(["x"]), "pw"), null, "tryDecrypt null");
    eq(s.encryption.isEncryptedPeekBlob(null), false, "peek 判定 false");
    // collection 单例性
    const c1 = s.collection("k"), c2 = s.collection("k");
    eq(c1, c2, "同名 collection 单例");
    // dormant auth
    const a = createDormantAuth();
    eq(a.isAuthConfigured(), false, "auth 未配置");
    eq(a.isSignedIn(), false, "未登录");
  });
});

describe("store-absent · 整段 boot smoke（子进程）", () => {
  it("WEBPAINT_NOSTORE=1 下 app.ts 整段 boot 不炸", async () => {
    const child = fileURLToPath(new URL("./nostore-boot-child.mjs", import.meta.url));
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [child], {
        env: { ...process.env, WEBPAINT_NOSTORE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => resolve({ code, err }));
    });
    assert(r.code === 0, `nostore boot 子进程退出码 ${r.code}：\n${r.err.slice(0, 2000)}`);
  });
});
