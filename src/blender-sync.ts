// Blender 同步：从 WebPaint 推 / 拉贴图到 Blender（经 BlenderTextureProtocol）。
//
// 插件式隔离的子功能：唯一对外入口 initBlenderSync(ctx)。组合根在 app.ts 末尾接一行。
// 依赖面收窄到三处，全是别人家的深模块 / 契约，本模块零格式知识：
//   - AppContext seam（doc / board / pixelHistory / setStatus / withBusy / …）
//   - vendored btp 客户端（../vendor/btp/v1/index.js）——推/拉的网络 + WebRTC 配对全在里面
//   - 三个 WebPaint 深模块：renderDocToImageBlob（唯一合成器）、smartResample（安全缩放，
//     step-halving 抗锯齿，缩小到小贴图不糊）、Layer.restoreFromSnapshot（换 canvas + 复位 bbox）
//
// 协议立场（别在这重新发明）：贴图靠 name 识别；推 = 整张覆盖，无冲突解决 by design。
// 不碰 store 红线：只调 store.edits.mark() 公共 API（同 import-image.ts），其余持久化全走库。

import type { AppContext } from "./app-context.ts";
import type { Layer } from "./doc.ts";
import { store } from "./app-store.ts";
import { renderDocToImageBlob } from "./session.ts";
import { smartResample, canvasToBlob } from "./resample.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { safeLS, safeLSSet } from "./safe-ls.ts";
import { BTPClient, BTPError, connectRemote, ManualSignaling } from "../vendor/btp/v1/index.js";

const POS_KEY = "webpaint.blenderPanel.pos";

const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// ─── 模块状态（单实例；panel 与连接随 app 生命周期常驻）───
let ctx: AppContext;
let client: BTPClient | null = null;       // 连上后的客户端（localhost 或 WebRTC，API 同形）
let conn: { close(): void } | null = null;  // WebRTC 连接句柄（localhost 时为 null）

// ─── DOM 引用（buildPanel 填充）───
let panel: HTMLDivElement;
let dot: HTMLSpanElement;
let connText: HTMLSpanElement;
let disconnectBtn: HTMLButtonElement;
let offerInput: HTMLTextAreaElement;
let answerRow: HTMLDivElement;
let answerOutput: HTMLTextAreaElement;
let nameInput: HTMLInputElement;
let texList: HTMLDataListElement;
let sizeSelect: HTMLSelectElement;

function q<T extends Element>(sel: string): T {
  const e = panel.querySelector(sel);
  if (!e) throw new Error("blender-sync: missing element " + sel);
  return e as unknown as T;
}

export function initBlenderSync(c: AppContext) {
  ctx = c;
  buildPanel();
  // 顶栏三条杠菜单的入口（按钮静态写在 index.html 的 menuPanel 里）
  document.getElementById("menuBlender")?.addEventListener("click", () => {
    setMenuOpen(false);
    togglePanel(true);
  });
}

// ───────────────────────── 连接 ─────────────────────────

// 同机：localhost HTTP。Blender 那侧需 per-session 开启端口（consent 在 Blender 面板）。
async function connectLocal() {
  try {
    await ctx.withBusy("Connecting to Blender…", async () => {
      const c = new BTPClient();      // http://127.0.0.1:18765
      await c.getScene();             // 探活：不可达 / 未开端口 → 抛
      client = c;
      conn = null;
    });
    setConn("connected", "this PC");
    await refreshTextureList();
    ctx.setStatus("Connected to Blender");
  } catch (e) {
    setConn("disconnected", "");
    ctx.setStatus("Could not reach Blender — enable the server in Blender's BTP panel first", true);
    console.warn("[btp] connectLocal:", e);
  }
}

// 跨设备（iPad）：WebRTC 手动配对。Blender 是 offerer，我们 answer。
// connectRemote 在 channel 打开后才 resolve（要等用户把响应码贴回 Blender）→ 全程不上 fullscreen busy。
async function pairRemote() {
  const offerCode = offerInput.value.trim();
  if (!offerCode) { ctx.setStatus("Paste Blender's connection code first", true); return; }
  setConn("connecting", "");
  try {
    const rc = await connectRemote({
      signaling: ManualSignaling({
        offer: offerCode,
        // 握手途中回调：把我们的响应码亮出来给用户复制回 Blender
        onAnswer: (code: string) => {
          answerOutput.value = code;
          answerRow.hidden = false;
        },
      }),
      handshakeTimeoutMs: 120000,   // 给人工复制粘贴留足时间
    });
    conn = rc;
    client = new BTPClient({ baseUrl: "", fetch: rc.fetch });
    const detail = rc.remoteFingerprint ? "remote · verify: " + rc.remoteFingerprint : "remote";
    setConn("connected", detail);
    await refreshTextureList();
    ctx.setStatus("Paired with Blender");
  } catch (e) {
    setConn("disconnected", "");
    ctx.setStatus("Pairing failed: " + errMsg(e), true);
  }
}

function disconnect() {
  try { conn?.close(); } catch { /* noop */ }
  conn = null;
  client = null;
  texList.innerHTML = "";
  answerRow.hidden = true;
  answerOutput.value = "";
  setConn("disconnected", "");
}

function setConn(state: "connected" | "connecting" | "disconnected", detail: string) {
  dot.dataset.state = state;
  connText.textContent =
    state === "connected" ? "Connected (" + detail + ")"
    : state === "connecting" ? "Connecting…"
    : "Disconnected";
  disconnectBtn.hidden = state !== "connected";
}

// ───────────────────────── 贴图发现 ─────────────────────────

async function refreshTextureList() {
  if (!client) return;
  try {
    const list = await client.listTextures();
    texList.innerHTML = "";
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.name;
      texList.appendChild(opt);
    }
  } catch (e) {
    ctx.setStatus("List textures failed: " + errMsg(e), true);
  }
}

async function useSelection() {
  if (!client) { ctx.setStatus("Connect to Blender first", true); return; }
  try {
    const sel = await client.getSelection();
    if (sel.texture) {
      nameInput.value = sel.texture;
      ctx.setStatus("Target set from Blender selection: " + sel.texture);
    } else {
      ctx.setStatus("No image selected in Blender", true);
    }
  } catch (e) {
    ctx.setStatus("Get selection failed: " + errMsg(e), true);
  }
}

// ───────────────────────── 推（WebPaint → Blender）─────────────────────────

// 把 doc 渲成要推的 PNG。size==="doc" → 原 doc 尺寸直接用合成器产物；
// 否则缩到方形预设：拉伸（不裁不留边），缩放全走 smartResample 深模块（抗锯齿）。
async function renderPushPng(scope: string, size: string): Promise<Blob> {
  const blob = await renderDocToImageBlob(ctx.doc, "image/png", undefined, scope);
  if (!blob) throw new Error("failed to render canvas");
  if (size === "doc") return blob;
  const target = Number(size);
  const bmp = await createImageBitmap(blob);
  try {
    const scaled = smartResample(bmp, target, target);   // stretch → target×target，安全缩小
    const out = await canvasToBlob(scaled, "image/png");
    if (!out) throw new Error("failed to encode PNG");
    return out;
  } finally {
    bmp.close();
  }
}

async function push() {
  if (!client) { ctx.setStatus("Connect to Blender first", true); return; }
  const name = nameInput.value.trim();
  if (!name) { ctx.setStatus("Enter a texture name", true); return; }
  const scopeEl = panel.querySelector<HTMLInputElement>('input[name="btpSrc"]:checked');
  const scope = scopeEl?.value === "active" ? "active" : "merged";
  const size = sizeSelect.value;
  try {
    await ctx.withBusy("Pushing to Blender…", async () => {
      const png = await renderPushPng(scope, size);
      try {
        await client!.putTextureData(name, png);    // 整张覆盖现有 image
      } catch (e) {
        // 不存在 → 新建（PUT 从不创建，见协议）
        if (e instanceof BTPError && e.code === "texture_not_found") {
          await client!.createTexture(name, png);
        } else {
          throw e;
        }
      }
    });
    ctx.setStatus('Pushed "' + name + '" to Blender');
    refreshTextureList();   // 新建的名字现在可见了
  } catch (e) {
    ctx.setStatus("Push failed: " + errMsg(e), true);
  }
}

// ───────────────────────── 拉（Blender → WebPaint）─────────────────────────

// 拉到新图层：贴图按原生分辨率居中放入新层（doc 尺寸不变）。沿用 import 的「新层不入 undo，
// 标脏即可，用户不要就删层」语义。返回 false = 图层已达上限（已弹状态）。
function placeBitmapAsNewLayer(bmp: ImageBitmap, name: string): boolean {
  const doc = ctx.doc;
  const layer = doc.addLayer(name);
  if (!layer) {
    ctx.setStatus("Layer limit reached (" + doc.maxLayers + ")", true);
    return false;
  }
  const w = bmp.width, h = bmp.height;
  layer.restoreFromSnapshot({
    bboxX: Math.floor((doc.width - w) / 2),
    bboxY: Math.floor((doc.height - h) / 2),
    bboxW: w, bboxH: h,
    bitmap: bmp,
  });
  store.edits.mark();
  ctx.updateSaveStatus();
  ctx.afterDocChange();
  return true;
}

// 覆盖当前图层：换成贴图（原生分辨率，从 (0,0) 起）。走 pixelHistory 事务 → 可 Ctrl-Z 还原旧像素。
function overwriteLeaf(leaf: Layer, bmp: ImageBitmap) {
  const tx = ctx.pixelHistory.begin(leaf, "stroke");   // 立刻拍 before
  const w = bmp.width, h = bmp.height;
  leaf.restoreFromSnapshot({ bboxX: 0, bboxY: 0, bboxW: w, bboxH: h, bitmap: bmp });
  tx.commit();                                         // 拍 after + 入 undo 栈（自带 wp:histchange）
  ctx.board.invalidateAll();
  ctx.board.requestRender();
  ctx.renderLayersPanel();                             // 刷缩略图
  store.edits.mark();
  ctx.updateSaveStatus();
}

async function pull(mode: "new" | "overwrite") {
  if (!client) { ctx.setStatus("Connect to Blender first", true); return; }
  const name = nameInput.value.trim();
  if (!name) { ctx.setStatus("Enter a texture name", true); return; }

  // overwrite 先确认有可写叶（组/隐藏/无 → 不白拉），fail fast
  let leaf: Layer | null = null;
  if (mode === "overwrite") {
    leaf = requireEditableLeaf(ctx.doc, ctx.setStatus) as Layer | null;
    if (!leaf) return;   // requireEditableLeaf 已弹标准状态行
  }

  try {
    let ok = true;
    await ctx.withBusy("Pulling from Blender…", async () => {
      const blob = await client!.getTextureData(name);
      const bmp = await createImageBitmap(blob);
      try {
        if (mode === "new") {
          ok = placeBitmapAsNewLayer(bmp, name);
        } else {
          overwriteLeaf(leaf as Layer, bmp);
        }
      } finally {
        bmp.close();
      }
    });
    if (ok) {
      ctx.setStatus('Pulled "' + name + '" → ' + (mode === "new" ? "new layer" : "current layer"));
    }
  } catch (e) {
    ctx.setStatus("Pull failed: " + errMsg(e), true);
  }
}

// ───────────────────────── 面板 DOM ─────────────────────────

function togglePanel(force?: boolean) {
  const hidden = panel.classList.contains("hidden");
  const show = force === undefined ? hidden : force;
  panel.classList.toggle("hidden", !show);
  if (show) document.body.appendChild(panel);   // 置顶
}

function buildPanel() {
  panel = document.createElement("div");
  panel.className = "float-panel btp-panel hidden";
  panel.id = "blenderPanel";
  panel.innerHTML = `
    <div class="float-panel-head" id="btpHead">
      <span class="float-panel-title">Blender Sync</span>
      <button class="float-panel-close" id="btpClose" type="button" aria-label="Close">×</button>
    </div>
    <div class="float-panel-body">
      <div class="btp-conn">
        <div class="btp-status"><span class="btp-dot" id="btpDot"></span><span id="btpConnText">Disconnected</span></div>
        <button class="btp-btn" id="btpConnectLocal" type="button">Connect (this PC)</button>
        <details class="btp-remote">
          <summary>Remote device (iPad)…</summary>
          <label class="btp-label" for="btpOffer">Blender connection code</label>
          <textarea id="btpOffer" class="btp-area" rows="2" placeholder="Paste BTP1:… from Blender"></textarea>
          <button class="btp-btn" id="btpPair" type="button">Pair</button>
          <div id="btpAnswerRow" hidden>
            <label class="btp-label" for="btpAnswer">Your response → paste into Blender</label>
            <textarea id="btpAnswer" class="btp-area" rows="2" readonly></textarea>
            <button class="btp-btn" id="btpCopyAnswer" type="button">Copy response</button>
          </div>
        </details>
        <button class="btp-btn" id="btpDisconnect" type="button" hidden>Disconnect</button>
      </div>
      <hr class="btp-sep" />
      <div class="btp-row">
        <label class="btp-label" for="btpName">Texture (name = id)</label>
        <input id="btpName" class="btp-input" list="btpTexList" placeholder="image name" />
        <datalist id="btpTexList"></datalist>
        <div class="btp-btnrow">
          <button class="btp-btn btp-sm" id="btpUseSel" type="button">Use selection</button>
          <button class="btp-btn btp-sm" id="btpRefresh" type="button">Refresh list</button>
        </div>
      </div>
      <hr class="btp-sep" />
      <div class="btp-row">
        <div class="btp-label">Pull from Blender</div>
        <div class="btp-btnrow">
          <button class="btp-btn" id="btpPullNew" type="button">→ New layer</button>
          <button class="btp-btn" id="btpPullOver" type="button">→ Overwrite layer</button>
        </div>
      </div>
      <hr class="btp-sep" />
      <div class="btp-row">
        <div class="btp-label">Push to Blender</div>
        <div class="btp-radio">
          <label><input type="radio" name="btpSrc" value="merged" checked /> Merged canvas</label>
          <label><input type="radio" name="btpSrc" value="active" /> Current layer / group</label>
        </div>
        <label class="btp-label" for="btpSize">Resolution (stretch-fit)</label>
        <select id="btpSize" class="btp-input">
          <option value="doc">Doc size</option>
          <option value="128">128 × 128</option>
          <option value="256">256 × 256</option>
          <option value="512">512 × 512</option>
          <option value="1024">1024 × 1024</option>
          <option value="2048">2048 × 2048</option>
        </select>
        <button class="btp-btn primary" id="btpPush" type="button">Push to Blender</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // 引用
  dot = q("#btpDot");
  connText = q("#btpConnText");
  disconnectBtn = q("#btpDisconnect");
  offerInput = q("#btpOffer");
  answerRow = q("#btpAnswerRow");
  answerOutput = q("#btpAnswer");
  nameInput = q("#btpName");
  texList = q("#btpTexList");
  sizeSelect = q("#btpSize");

  // 行为接线
  q<HTMLButtonElement>("#btpClose").addEventListener("click", () => togglePanel(false));
  q<HTMLButtonElement>("#btpConnectLocal").addEventListener("click", () => { void connectLocal(); });
  q<HTMLButtonElement>("#btpPair").addEventListener("click", () => { void pairRemote(); });
  disconnectBtn.addEventListener("click", disconnect);
  q<HTMLButtonElement>("#btpCopyAnswer").addEventListener("click", () => {
    answerOutput.select();
    void navigator.clipboard?.writeText(answerOutput.value).then(
      () => ctx.setStatus("Response code copied"),
      () => { /* 用户可手动复制选中文本 */ },
    );
  });
  q<HTMLButtonElement>("#btpUseSel").addEventListener("click", () => { void useSelection(); });
  q<HTMLButtonElement>("#btpRefresh").addEventListener("click", () => { void refreshTextureList(); });
  q<HTMLButtonElement>("#btpPullNew").addEventListener("click", () => { void pull("new"); });
  q<HTMLButtonElement>("#btpPullOver").addEventListener("click", () => { void pull("overwrite"); });
  q<HTMLButtonElement>("#btpPush").addEventListener("click", () => { void push(); });

  attachDrag(q<HTMLDivElement>("#btpHead"));
  restorePos();
}

// 拖动面板头（沿用 layers-panel / color-panel 模式）。
function attachDrag(head: HTMLElement) {
  let drag: { id: number; sx: number; sy: number; ol: number; ot: number } | null = null;
  head.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest(".float-panel-close")) return;
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
    const top = Math.max(0, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));
    panel.style.left = left + "px";
    panel.style.right = "auto";
    panel.style.top = top + "px";
    safeLSSet(POS_KEY, JSON.stringify({ left, top }));
  });
  head.addEventListener("pointerup", (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      try { head.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      drag = null;
    }
  });
}

function restorePos() {
  const saved = safeLS(POS_KEY);
  if (!saved) return;
  try {
    const o = JSON.parse(saved) as { left: number; top: number };
    panel.style.left = o.left + "px";
    panel.style.right = "auto";
    panel.style.top = o.top + "px";
  } catch { /* 忽略坏值 */ }
}
