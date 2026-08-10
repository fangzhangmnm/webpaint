#!/usr/bin/env node
// WebPaint MCP server（C8 ④）——backend 接口的机械翻译（提案 §3：「这一份接口同时是 MCP 面、
// postMessage 面、multiplayer 序列化面（同一把刀）」）。stdio 传输、newline-delimited JSON-RPC 2.0，
// 手搓协议零依赖（家规：vendor 一切、无 runtime npm install——MCP 官方 SDK 不进 repo）。
//
// 用法：node scripts/mcp-server.mjs（node ≥22.18，TS 直跑）；或 npm run mcp。
// 注册示例（Claude Code）：claude mcp add webpaint -- node <repo>/scripts/mcp-server.mjs
//
// 语义（与 webpaint-backend-interface.ts 一致，不另立协议）：
//   - 单租户会话：create/open_file 弃旧建新（旧 backend interrupt=cancel 后 dispose）。
//   - 栅格/合成 = SoftGl2Port（决定论软域，ADR-0009）；exportImage/encodeOra 走注入合成面
//     ——「SoftGl2Port 兜底也能跑（MCP server 成立）」（提案 §0）；浏览器用户路径不受影响。
//   - 后端 throw → tool 结果 isError:true 带原文案（响亮拒绝穿墙而出，server 本体不死）。

import fs from "node:fs";
import readline from "node:readline";
import { ensureZipLoaded } from "../test/zip-node.mjs";   // vendored zip.js 的 node 装载器（encodeOra/open .ora 用；dev-only 面复用 test 侧装载器）
import { installDomParserShim } from "../test/xml-shim.mjs";   // open .ora 的 parseStackXml 用（node 无 DOMParser）
ensureZipLoaded();
installDomParserShim();

// ImageData 最小 shim（node 无）：ora encode 面（paintingDataToEncodeDoc.getImageData）拿它当
// 纯字节容器（{data,width,height}），与 test/dom-shim-first.mjs 同款。encode 面改纯 bytes 读口
// 后可拆（canvas 债余账，随后棒）。
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      if (typeof data === "number") { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
      this.data = data; this.width = width; this.height = height ?? (data.length / 4 / width);
    }
  };
}
import { WebPaintBackend } from "../src/backend/webpaint-backend.ts";
import { SoftGl2Port } from "../src/backend/soft-gl2-port.ts";
import { GlRoom, poolCapacityForBudget } from "../src/backend/gl/gl-room.ts";
import { RasterService } from "../src/backend/gl/raster-service.ts";
import { FILTER_KERNELS } from "../src/backend/filters/index.ts";
import { WEBPAINT_VERSION } from "../src/version.ts";

// ---- 会话状态（单租户）----
let be = null;

// 栅格/合成域：server 级 SoftGl2Port（backend 的 stroke 域与 exportImage 合成面同一 Port——
// 决定论同一软域；per-tenant 合成注入 = C7 v0.8.38 语义，全局接缝不碰）。
function mkInject() {
  const port = new SoftGl2Port();
  const room = new GlRoom(port, poolCapacityForBudget(256 * 1024 * 1024));
  const raster = new RasterService(room);
  return {
    appVersion: WEBPAINT_VERSION,
    gl: port,
    compositorBytes: (nodes, w, h) => raster.compositeToBytes(nodes, w, h),
  };
}

function requireBackend() {
  if (!be || be.disposed) throw new Error("无活动文档——先 create 或 open_file");
  return be;
}

function replaceBackend(next) {
  if (be && !be.disposed) be.dispose();   // interrupt=cancel 家规：open 事务随 dispose 收口
  be = next;
}

// points 收口：接受 [[x,y,p,t],…] 或扁平 [x,y,p,t,…]，出 Float32Array stride=4。
function toPoints(raw) {
  if (!Array.isArray(raw)) throw new Error("points 必须是数组（[[x,y,p,t],…] 或扁平 stride=4）");
  const flat = Array.isArray(raw[0]) ? raw.flat() : raw;
  return Float32Array.from(flat);
}

const MAX_INLINE_BYTES = 8 * 1024 * 1024;
function bytesOut(u8, path) {
  if (path) { fs.writeFileSync(path, u8); return { path, bytes: u8.length }; }
  if (u8.length > MAX_INLINE_BYTES) throw new Error(`产物 ${u8.length} 字节超 inline 上限——传 path 落盘`);
  return { bytes: u8.length, base64: Buffer.from(u8).toString("base64") };
}

// ---- tool 清单（name → {description, inputSchema, handler}）----
const num = { type: "number" };
const str = { type: "string" };
const obj = (props, required = []) => ({ type: "object", properties: props, required });

const TOOLS = {
  // ── 生命周期 ──
  create: {
    description: "新建空白画布（弃旧建新）；返回 docInfo",
    inputSchema: obj({ width: num, height: num, backgroundColor: str }, ["width", "height"]),
    handler: (a) => {
      replaceBackend(WebPaintBackend.blank({ width: a.width, height: a.height, backgroundColor: a.backgroundColor }, mkInject()));
      return be.docInfo();
    },
  },
  open_file: {
    description: "打开本地文件（.ora/.png/位图；魔数嗅探路由）；弃旧建新，返回 docInfo",
    inputSchema: obj({ path: str }, ["path"]),
    handler: async (a) => {
      const { backend } = await WebPaintBackend.open(new Uint8Array(fs.readFileSync(a.path)), mkInject());
      replaceBackend(backend);
      return be.docInfo();
    },
  },
  dispose: {
    description: "释放当前文档（open 事务 interrupt=cancel）",
    inputSchema: obj({}),
    handler: () => { if (be && !be.disposed) be.dispose(); be = null; return { ok: true }; },
  },

  // ── 读面 ──
  doc_info:   { description: "文档信息（尺寸/背景/活动层/层数）", inputSchema: obj({}), handler: () => requireBackend().docInfo() },
  layer_tree: { description: "层树（bottom-first）", inputSchema: obj({}), handler: () => requireBackend().layerTree() },
  is_dirty:   { description: "未保存变更？", inputSchema: obj({}), handler: () => ({ dirty: requireBackend().isDirty() }) },
  mark_saved: { description: "标记已保存", inputSchema: obj({}), handler: () => { requireBackend().markSaved(); return { ok: true }; } },

  // ── 层结构 verbs ──
  layer_add:        { description: "加层", inputSchema: obj({ name: str }), handler: (a) => requireBackend().layerAdd(a.name) },
  layer_duplicate:  { description: "复制层", inputSchema: obj({ id: num }, ["id"]), handler: (a) => requireBackend().layerDuplicate(a.id) },
  layer_remove:     { description: "删层", inputSchema: obj({ id: num }, ["id"]), handler: (a) => requireBackend().layerRemove(a.id) },
  layer_move:       { description: "移层（delta 为栈内位移）", inputSchema: obj({ id: num, delta: num }, ["id", "delta"]), handler: (a) => requireBackend().layerMove(a.id, a.delta) },
  layer_merge_down: { description: "向下合并", inputSchema: obj({ id: num }, ["id"]), handler: (a) => requireBackend().layerMergeDown(a.id) },
  layer_set_prop:   {
    description: "设层属性（name/visible/opacity/mode/clippingMask/lockAlpha）",
    inputSchema: obj({ id: num, prop: str, value: { type: ["string", "number", "boolean"] } }, ["id", "prop", "value"]),
    handler: (a) => requireBackend().layerSetProp(a.id, a.prop, a.value),
  },
  layer_set_active: { description: "设活动层", inputSchema: obj({ id: num }, ["id"]), handler: (a) => ({ ok: requireBackend().layerSetActive(a.id) }) },
  layer_clear:      { description: "清层像素", inputSchema: obj({ id: num }, ["id"]), handler: (a) => requireBackend().layerClear(a.id) },
  set_reference_layer: { description: "设/清参考层（id=null 清）", inputSchema: obj({ id: { type: ["number", "null"] } }, ["id"]), handler: (a) => requireBackend().setReferenceLayer(a.id ?? null) },

  // ── doc 几何 ──
  crop: {
    description: "裁剪/扩张画布（允许 x/y 负、w/h 超原尺寸的负向扩张；1..8192）",
    inputSchema: obj({ x: num, y: num, w: num, h: num }, ["x", "y", "w", "h"]),
    handler: (a) => requireBackend().crop(a.x, a.y, a.w, a.h),
  },

  // ── undo ──
  undo:     { description: "撤销一步（open 事务期间响亮拒绝）", inputSchema: obj({}), handler: () => ({ ok: requireBackend().undo() }) },
  redo:     { description: "重做一步", inputSchema: obj({}), handler: () => ({ ok: requireBackend().redo() }) },
  can_undo: { description: "可撤销？", inputSchema: obj({}), handler: () => ({ canUndo: requireBackend().canUndo() }) },
  can_redo: { description: "可重做？", inputSchema: obj({}), handler: () => ({ canRedo: requireBackend().canRedo() }) },

  // ── stroke 档口 ──
  stroke_begin: {
    description: "开一笔（brush = ResolvedBrush 快照片段，缺字段吃默认；mode:'erase' 擦除）；返回 strokeId",
    inputSchema: obj({ leafId: num, brush: { type: "object" } }, ["leafId"]),
    handler: (a) => ({ strokeId: requireBackend().strokeBegin(a.leafId, a.brush ?? {}) }),
  },
  stroke_append: {
    description: "喂点（points = [[x,y,p,t],…] 或扁平 stride=4；p=压感 0..1，t=事件毫秒钟）",
    inputSchema: obj({ id: num, points: { type: "array" } }, ["id", "points"]),
    handler: (a) => { requireBackend().strokeAppend(a.id, toPoints(a.points)); return { ok: true }; },
  },
  stroke_end:    { description: "收笔落账（false = no-op 未占 undo 步）", inputSchema: obj({ id: num }, ["id"]), handler: (a) => ({ committed: requireBackend().strokeEnd(a.id) }) },
  stroke_cancel: { description: "弃笔（无痕）", inputSchema: obj({ id: num }, ["id"]), handler: (a) => { requireBackend().strokeCancel(a.id); return { ok: true }; } },
  draw: {
    description: "便捷一笔：begin+append+end 一次完成（等价三连调）",
    inputSchema: obj({ leafId: num, brush: { type: "object" }, points: { type: "array" } }, ["leafId", "points"]),
    handler: (a) => {
      const b = requireBackend();
      const id = b.strokeBegin(a.leafId, a.brush ?? {});
      try { b.strokeAppend(id, toPoints(a.points)); } catch (e) { b.strokeCancel(id); throw e; }
      return { committed: b.strokeEnd(id) };
    },
  },

  // ── filter 档口 ──
  filter_list: { description: "可用 region filter 清单（id + 默认参数）", inputSchema: obj({}), handler: () => Object.values(FILTER_KERNELS).map((k) => ({ id: k.id, defaults: k.defaults() })) },
  filter_begin: {
    description: "开 filter 事务（冻结源；filterId 见 filter_list）；返回 filterSessionId",
    inputSchema: obj({ leafId: num, filterId: str }, ["leafId", "filterId"]),
    handler: (a) => ({ filterSessionId: requireBackend().filterBegin(a.leafId, a.filterId) }),
  },
  filter_set_params: {
    description: "设参数（合并到默认底座、从冻结源重算——不累积）",
    inputSchema: obj({ id: num, params: { type: "object" } }, ["id", "params"]),
    handler: (a) => { requireBackend().filterSetParams(a.id, a.params ?? {}); return { ok: true }; },
  },
  filter_commit: { description: "落层一步（false = identity 未占步）", inputSchema: obj({ id: num }, ["id"]), handler: (a) => ({ committed: requireBackend().filterCommit(a.id) }) },
  filter_cancel: { description: "弃 filter 事务（无痕）", inputSchema: obj({ id: num }, ["id"]), handler: (a) => { requireBackend().filterCancel(a.id); return { ok: true }; } },

  // ── 字节面 ──
  export_image: {
    description: "导出合成图（png；SoftGl2 软合成）。path 给了写文件，否则返回 base64",
    inputSchema: obj({ fmt: { type: "string", enum: ["png"] }, path: str }),
    handler: async (a) => bytesOut(await requireBackend().exportImage(a.fmt ?? "png"), a.path),
  },
  encode_ora: {
    description: "编码 .ora（含 mergedimage 缩略图；决定论 zip）。path 给了写文件，否则返回 base64",
    inputSchema: obj({ path: str }),
    handler: async (a) => bytesOut(await requireBackend().encodeOra(), a.path),
  },
};

// ---- JSON-RPC 2.0 / MCP 协议壳（newline-delimited）----
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "webpaint-backend", version: WEBPAINT_VERSION },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;   // 通知无应答
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === "tools/call") {
    const t = TOOLS[params?.name];
    if (!t) return reply(id, { content: [{ type: "text", text: `未知 tool：${params?.name}` }], isError: true });
    try {
      const result = await t.handler(params?.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (e) {
      // 后端响亮拒绝穿墙而出：isError + 原文案（令牌墙/未注册 id/非法参数……server 不死）
      return reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
    }
  }
  if (id !== undefined && id !== null) replyErr(id, -32601, `method 不存在：${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return replyErr(null, -32700, "parse error"); }
  Promise.resolve(handle(msg)).catch((e) => { if (msg.id != null) replyErr(msg.id, -32603, String(e?.message ?? e)); });
});
rl.on("close", () => { if (be && !be.disposed) be.dispose(); process.exit(0); });
