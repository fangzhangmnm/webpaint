// IDB 配额撞墙 → store `reqTx` 静默成功 的判定性复现（带对照组）。
//
// 背景：`@internal/store` 的 idb-store.ts `reqTx` 在 **request 的 onsuccess** 就 resolve，
//   不等事务 commit，也没挂 tx.onabort。而配额撞墙时 IDB 的真实事件顺序是
//   `req.success → tx.abort(QuotaExceededError)` —— 于是一次没落盘的写被报成成功。
//   详见 ai-docs/20260821-storage-eviction-investigation.md §B.2 / escalation E1。
//
// 跑法：npm i（要 playwright）后 `node tools/idb-quota-repro.mjs`
// 期望输出：对照组「读回 → 在」；实验组「目标 put() → resolve」且「读回 → **不在**」。
//   E1 修好之后，实验组应该变成「目标 put() → reject QuotaExceededError」。
//   （这脚本就是 E1 的验收判据；建议随 E1 一起收编进 store 库的 CI。）
//
// 注：不是单元测试（要真浏览器 + CDP 压配额），所以放 tools/ 不放 test/ —— test/run.mjs 是显式 import 发现，不会误收。
import { chromium } from "playwright";
import http from "node:http";

const PORT = 8934;
const srv = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>idb-quota-repro</title>");
});
await new Promise((r) => srv.listen(PORT, r));

const scenario = async (quotaMiB, label) => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  if (quotaMiB) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: `http://localhost:${PORT}`, quotaSize: quotaMiB * 1024 * 1024 });
    await page.reload();
  }
  const out = await page.evaluate(async (fillBlocks) => {
    // ── 逐字复刻 @internal/store v0.3.0 出货产物 dist/idb-store.js 的 reqTx ──
    const dbName = "idb-quota-repro", STORE = "blobs";
    const openDb = () => new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const reqTx = (mode, run) => openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // ← 原实现到此为止：没有 t.oncomplete / t.onabort
    }));
    const put = (n, r) => reqTx("readwrite", (s) => s.put(r, n)).then(() => undefined);
    const get = (n) => reqTx("readonly", (s) => s.get(n));
    // ────────────────────────────────────────────────────────────────────────
    const blob = (mb) => new Blob([new Uint8Array(mb * 1024 * 1024)]);
    const L = []; let unhandled = 0;
    addEventListener("unhandledrejection", () => unhandled++);

    let filled = 0;
    for (let i = 0; i < fillBlocks; i++) {
      try { await put("f" + i, { blob: blob(8), updatedAt: Date.now() }); filled++; }
      catch (e) { L.push("填充在第 " + i + " 块 reject " + e.name); break; }
    }
    L.push("填充 " + filled + "/" + fillBlocks + " 块 resolve（" + filled * 8 + " MiB 声称已写）");

    const KEY = "the-artwork.ora";
    let resolved = false, threw = null;
    try { await put(KEY, { blob: blob(8), updatedAt: Date.now() }); resolved = true; }
    catch (e) { threw = e.name; }
    L.push("目标 put() → " + (resolved ? "resolve" : "reject " + threw));

    await new Promise((r) => setTimeout(r, 500));   // 给 abort 发生的时间
    let back = null;
    try { back = await get(KEY); } catch (e) { L.push("读回抛错 " + e); }
    L.push("读回 → " + (back ? "在（" + back.blob.size + " B）" : "**不在**"));
    L.push("unhandled rejection 数 " + unhandled);

    await new Promise((r) => { const q = indexedDB.deleteDatabase(dbName); q.onsuccess = q.onerror = q.onblocked = () => r(); });
    return L.join("\n");
  }, quotaMiB ? 40 : 2);
  console.log("\n===== " + label + " =====\n" + out);
  await browser.close();
};

await scenario(0, "对照组：不限配额（同一份 reqTx 代码）");
await scenario(48, "实验组：配额压到 48 MiB");
srv.close();
