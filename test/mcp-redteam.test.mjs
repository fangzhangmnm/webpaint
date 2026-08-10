// C8 ④ MCP server 红队（user：「你多红队一点」）——spawn 真 server 子进程、走真 stdio JSON-RPC，
// 不是进程内假打（协议壳/序列化墙/错误穿墙全在被测面里）：
//   ① 握手 + tools/list（验收动词 create/draw/crop/undo/redo/export 全在册）
//   ② 全流程：create → draw 斜线 → draw 圆（stroke 三连调）→ crop → doc_info 变 → undo/redo →
//      filter（hsb 亮度）→ export_image png（base64 → PNG 魔数）→ encode_ora（PK 魔数）
//   ③ 决定论穿墙：同指令序列两次 create+draw+export → base64 逐字符同（ADR-0009 过 MCP 面仍成立）
//   ④ 敌意输入 server 不死：未知 tool / 坏 JSON 行 / 坏 stride / 非法 crop / 无文档就画 /
//      令牌墙（open stroke 期间 undo/第二 begin）/ 错 id ——全部 isError/错误应答后 server 继续服务
import { describe, it, assert, eq } from "./runner.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
    this.buf = "";
    this.pending = new Map();
    this.seq = 0;
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
      }
    });
  }
  raw(s) { this.proc.stdin.write(s + "\n"); }
  rpc(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`MCP 应答超时：${method}`)), 30000);
      this.pending.set(id, (m) => { clearTimeout(to); resolve(m); });
      this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  /** tools/call → { isError, data }（data = 应答 text 的 JSON.parse，parse 不动就原文） */
  async call(name, args = {}) {
    const m = await this.rpc("tools/call", { name, arguments: args });
    if (m.error) return { isError: true, data: m.error.message };
    const text = m.result.content?.[0]?.text ?? "";
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { isError: !!m.result.isError, data };
  }
  kill() { this.proc.kill(); }
}

// 圆点序列（决定论：整数步进事件钟）
function circlePts(cx, cy, r, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0.8, i * 16]);
  }
  return pts;
}
const diagPts = (n = 8) => Array.from({ length: n }, (_, i) => [20 + i * 14, 24 + i * 10, 0.9, i * 16]);
const BRUSH = { size: 24, color: "#c03030", opacity: 1, streamline: 0, stabilization: 0, pressureLPF: 0 };
const b64head = (s, n) => Buffer.from(s, "base64").subarray(0, n);

describe("mcp-redteam · 握手与全流程", () => {
  it("initialize/tools/全动词流程/决定论/敌意输入（单 server 会话跑完——spawn 贵，场景串行）", async () => {
    const c = new McpClient();
    try {
      // ── ① 握手 ──
      const init = await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "redteam", version: "0" } });
      eq(init.result.serverInfo.name, "webpaint-backend");
      c.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const tools = (await c.rpc("tools/list", {})).result.tools.map((t) => t.name);
      for (const need of ["create", "draw", "crop", "undo", "redo", "export_image", "stroke_begin", "filter_begin", "encode_ora"]) {
        assert(tools.includes(need), `验收动词在册：${need}`);
      }

      // ── ④a 敌意先行：无文档就画/导出 → isError 响亮，server 活着 ──
      assert((await c.call("draw", { leafId: 1, points: diagPts() })).isError, "无文档 draw → isError");
      assert((await c.call("export_image", {})).isError, "无文档 export → isError");

      // ── ② 全流程 ──
      const info0 = (await c.call("create", { width: 200, height: 150 })).data;
      eq(info0.width, 200); eq(info0.layerCount, 1);
      const d1 = await c.call("draw", { leafId: 1, brush: BRUSH, points: diagPts() });
      assert(!d1.isError && d1.data.committed, "draw 斜线落一步");
      // 圆走 stroke 三连调（红队动词 circle = 圆点序列过 stroke 档）
      const sb = await c.call("stroke_begin", { leafId: 1, brush: { ...BRUSH, color: "#3060c0", size: 12 } });
      const sid = sb.data.strokeId;
      assert(!(await c.call("stroke_append", { id: sid, points: circlePts(100, 75, 40) })).isError);
      assert((await c.call("stroke_end", { id: sid })).data.committed, "圆落一步");

      // 令牌墙（open stroke 期间 undo / 第二 begin / 错 id → isError；cancel 后恢复）
      const sb2 = await c.call("stroke_begin", { leafId: 1, brush: BRUSH });
      assert((await c.call("undo", {})).isError, "open stroke 期间 undo → isError（门口令牌墙）");
      assert((await c.call("stroke_begin", { leafId: 1, brush: BRUSH })).isError, "第二 begin → isError");
      assert((await c.call("stroke_append", { id: 9999, points: diagPts(1) })).isError, "错 id → isError");
      assert(!(await c.call("stroke_cancel", { id: sb2.data.strokeId })).isError, "cancel 收口");

      // crop → doc_info 变 → undo 回 → redo 再crop
      assert((await c.call("crop", { x: 20, y: 10, w: 120, h: 100 })).data.ok, "crop ok");
      eq((await c.call("doc_info", {})).data.width, 120, "crop 后宽 120");
      assert((await c.call("undo", {})).data.ok);
      eq((await c.call("doc_info", {})).data.width, 200, "undo 回 200");
      assert((await c.call("redo", {})).data.ok);
      eq((await c.call("doc_info", {})).data.height, 100, "redo 回裁剪态");

      // filter：list → begin/set/commit（真变化占步）
      const fl = (await c.call("filter_list", {})).data;
      assert(fl.some((k) => k.id === "hsb"), "filter_list 有 hsb");
      const fb = await c.call("filter_begin", { leafId: 1, filterId: "hsb" });
      assert(!(await c.call("filter_set_params", { id: fb.data.filterSessionId, params: { brightness: 40 } })).isError);
      assert((await c.call("filter_commit", { id: fb.data.filterSessionId })).data.committed, "filter 落一步");

      // export：png 魔数 / ora PK 魔数
      const png = (await c.call("export_image", { fmt: "png" })).data;
      const head = b64head(png.base64, 4);
      assert(head[0] === 0x89 && head[1] === 0x50, "export png 魔数");
      const ora = (await c.call("encode_ora", {})).data;
      const oh = b64head(ora.base64, 2);
      assert(oh[0] === 0x50 && oh[1] === 0x4b, "encode_ora PK 魔数");

      // ── ③ 决定论穿墙：同指令序列两次 → export base64 逐字符同 ──
      const paintOnce = async () => {
        await c.call("create", { width: 96, height: 64 });
        await c.call("draw", { leafId: 1, brush: BRUSH, points: circlePts(48, 32, 20) });
        return (await c.call("export_image", {})).data.base64;
      };
      eq(await paintOnce(), await paintOnce(), "决定论过 MCP 面（ADR-0009）");

      // ── ④b 敌意收尾：坏 JSON 行 / 未知 tool / 坏 stride / 非法 crop → server 不死 ──
      c.raw("{这不是 json");
      assert((await c.call("nonexistent_tool", {})).isError, "未知 tool → isError");
      await c.call("create", { width: 64, height: 48 });
      const sb3 = await c.call("stroke_begin", { leafId: 1, brush: BRUSH });
      assert((await c.call("stroke_append", { id: sb3.data.strokeId, points: [1, 2, 3] })).isError, "坏 stride → isError");
      await c.call("stroke_cancel", { id: sb3.data.strokeId });
      eq((await c.call("crop", { x: 0, y: 0, w: 0, h: 50 })).data.ok, false, "w=0 → ok:false");
      assert((await c.call("filter_begin", { leafId: 1, filterId: "nope" })).isError, "未注册 filter → isError");
      // 坏 JSON 之后 server 仍在服务（上面这串都应答了）；最后正常画一笔证活
      assert((await c.call("draw", { leafId: 1, brush: BRUSH, points: diagPts(4) })).data.committed, "红队完毕 server 仍健在");
    } finally {
      c.kill();
    }
  }, { timeout: 30_000 });   // 延长：spawn 真 MCP server 子进程全流程（暖 ~2s，冷可超默认 10s）
});
