// Blender 同步：从 WebPaint 推 / 拉贴图到 Blender（经 BlenderTextureProtocol）。
//
// 插件式隔离的子功能：唯一对外入口 initBlenderSync(ctx)，外加随文档持久化的 get/applyBlenderSyncState。
// 依赖面收窄到三处，全是别人家的深模块 / 契约，本模块零格式知识：
//   - AppContext seam（doc / board / pixelHistory / setStatus / withBusy / …）
//   - vendored btp 客户端（../vendor/btp/v1/index.js）——推/拉的网络 + WebRTC 配对全在里面
//   - 三个 WebPaint 深模块：renderDocToImageBlob（唯一合成器）、smartResample（安全缩放，
//     step-halving 抗锯齿，缩小到小贴图不糊）、Layer.restoreFromSnapshot（换 canvas + 复位 bbox）
//
// UI 中文（跟 WebPaint 一致）。交互沿用 app 既有「smart 按钮」范式：连接键 = 智能保存键那种
// 单键多态（连接/连接中/已连接，点击随态切动作）；拉取/推送 = 菜单里 smart 导入导出那种 main + ⋯ 配置。
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

// ─── 内联 SVG 图标（currentColor → 由 data-state CSS 着色 / spin）───
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_OFF = svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>');                                   // 云
const ICON_ON = svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/>'); // 云+勾
const ICON_BUSY = svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin:12px 13px"><path d="M9 13a3 3 0 0 1 5.5-1.6"/></g>');
const ICON_DL = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/>'); // 下载
const ICON_UL = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>');    // 上传

// ─── 模块状态（单实例；panel 与连接随 app 生命周期常驻）───
let ctx: AppContext;
let client: BTPClient | null = null;        // 连上后的客户端（localhost 或 WebRTC，API 同形）
let conn: { close(): void } | null = null;  // WebRTC 连接句柄（localhost 时为 null）
let connState: "off" | "connecting" | "on" = "off";
let connDetail = "";
let pullTarget: "new" | "overwrite" = "new";    // 拉取去向
let uploadSource: "merged" | "active" = "merged"; // 推送来源
let built = false;

// ─── DOM 引用（buildPanel 填充）───
let panel: HTMLDivElement;
let connBtn: HTMLButtonElement;
let offerInput: HTMLTextAreaElement;
let answerRow: HTMLDivElement;
let answerOutput: HTMLTextAreaElement;
let nameInput: HTMLInputElement;
let texList: HTMLDataListElement;
let sizeW: HTMLInputElement;
let sizeH: HTMLInputElement;
let dlSub: HTMLSpanElement;
let ulSub: HTMLSpanElement;

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
  // 点面板外 → 收起所有 ⋯ 弹层
  document.addEventListener("pointerdown", (e) => {
    if (!panel.contains(e.target as Node)) closeAllPopups();
  });
}

// ───────────────────────── 连接（单键多态）─────────────────────────

function setConnState(s: "off" | "connecting" | "on", detail = "") {
  connState = s;
  connDetail = detail;
  connBtn.dataset.state = s;
  connBtn.disabled = s === "connecting";
  const inner =
    s === "on" ? ICON_ON + `<span>已连接${detail ? " · " + detail : ""}</span>`
    : s === "connecting" ? ICON_BUSY + "<span>连接中…</span>"
    : ICON_OFF + "<span>连接 Blender</span>";
  connBtn.innerHTML = inner;
}

// 连接键点击：断开↔连本机（连接中忽略）。远程配对走旁边的 ⋯。
function onConnClick() {
  if (connState === "on") disconnect();
  else if (connState === "off") void connectLocal();
}

// 同机：localhost HTTP。Blender 那侧需 per-session 开启端口（consent 在 Blender 面板）。
async function connectLocal() {
  setConnState("connecting");
  try {
    const c = new BTPClient();   // http://127.0.0.1:18765
    await c.getScene();          // 探活：不可达 / 未开端口 → 抛
    client = c;
    conn = null;
    setConnState("on", "本机");
    await refreshTextureList();
    ctx.setStatus("已连接 Blender");
  } catch (e) {
    client = null;
    setConnState("off");
    ctx.setStatus("连不上 Blender —— 先在 Blender 的 BTP 面板里开启端口", true);
    console.warn("[btp] connectLocal:", e);
  }
}

// 跨设备（iPad）：WebRTC 手动配对。Blender 是 offerer，我们 answer。
// connectRemote 在 channel 打开后才 resolve（要等用户把响应码贴回 Blender）。
async function pairRemote() {
  const offerCode = offerInput.value.trim();
  if (!offerCode) { ctx.setStatus("先粘贴 Blender 的连接码", true); return; }
  setConnState("connecting");
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
    setConnState("on", "远程");
    closeAllPopups();
    await refreshTextureList();
    ctx.setStatus("已与 Blender 配对");
  } catch (e) {
    client = null;
    setConnState("off");
    ctx.setStatus("配对失败：" + errMsg(e), true);
  }
}

function disconnect() {
  try { conn?.close(); } catch { /* noop */ }
  conn = null;
  client = null;
  texList.innerHTML = "";
  answerRow.hidden = true;
  answerOutput.value = "";
  setConnState("off");
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
    ctx.setStatus("拉取贴图列表失败：" + errMsg(e), true);
  }
}

async function useSelection() {
  if (!client) { ctx.setStatus("请先连接 Blender", true); return; }
  try {
    const sel = await client.getSelection();
    if (sel.texture) {
      nameInput.value = sel.texture;
      ctx.setStatus("已用 Blender 选中贴图：" + sel.texture);
    } else {
      ctx.setStatus("Blender 里没有选中贴图", true);
    }
  } catch (e) {
    ctx.setStatus("读取选中失败：" + errMsg(e), true);
  }
}

// ───────────────────────── 推（WebPaint → Blender）─────────────────────────

// 两个文本框 → 目标尺寸（W×H，可非方形拉伸）。都空 → null（= 原 doc 尺寸，不缩放）。
// 单轴空 → 该轴回退 doc 尺寸。上限 8192 防误填。
function parseTargetSize(): { w: number; h: number } | null {
  const pw = sizeW.value.trim();
  const ph = sizeH.value.trim();
  if (!pw && !ph) return null;
  const num = (s: string, fallback: number) => {
    const n = Math.round(Number(s.replace(/[^0-9.]/g, "")));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8192) : fallback;
  };
  return { w: num(pw, ctx.doc.width), h: num(ph, ctx.doc.height) };
}

// 把 doc 渲成要推的 PNG。target===null → 原 doc 尺寸直接用合成器产物；
// 否则缩到 W×H：拉伸（不裁不留边），缩放全走 smartResample 深模块（抗锯齿）。
async function renderPushPng(scope: string, target: { w: number; h: number } | null): Promise<Blob> {
  const blob = await renderDocToImageBlob(ctx.doc, "image/png", undefined, scope);
  if (!blob) throw new Error("渲染画布失败");
  if (!target) return blob;
  const bmp = await createImageBitmap(blob);
  try {
    const scaled = smartResample(bmp, target.w, target.h);   // stretch → W×H，安全缩小
    const out = await canvasToBlob(scaled, "image/png");
    if (!out) throw new Error("编码 PNG 失败");
    return out;
  } finally {
    bmp.close();
  }
}

async function push() {
  if (!client) { ctx.setStatus("请先连接 Blender", true); return; }
  const name = nameInput.value.trim();
  if (!name) { ctx.setStatus("请填贴图名", true); return; }
  const target = parseTargetSize();
  try {
    await ctx.withBusy("正在推送到 Blender…", async () => {
      const png = await renderPushPng(uploadSource, target);
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
    ctx.setStatus(`已推送「${name}」到 Blender`);
    refreshTextureList();   // 新建的名字现在可见了
  } catch (e) {
    ctx.setStatus("推送失败：" + errMsg(e), true);
  }
}

// ───────────────────────── 拉（Blender → WebPaint）─────────────────────────

// 拉到新图层：贴图按原生分辨率居中放入新层（doc 尺寸不变）。沿用 import 的「新层不入 undo，
// 标脏即可，用户不要就删层」语义。返回 false = 图层已达上限（已弹状态）。
function placeBitmapAsNewLayer(bmp: ImageBitmap, name: string): boolean {
  const doc = ctx.doc;
  const layer = doc.addLayer(name);
  if (!layer) {
    ctx.setStatus(`图层已达上限（${doc.maxLayers}）`, true);
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

async function pull() {
  if (!client) { ctx.setStatus("请先连接 Blender", true); return; }
  const name = nameInput.value.trim();
  if (!name) { ctx.setStatus("请填贴图名", true); return; }

  // 覆盖模式先确认有可写叶（组/隐藏/无 → 不白拉），fail fast
  let leaf: Layer | null = null;
  if (pullTarget === "overwrite") {
    leaf = requireEditableLeaf(ctx.doc, ctx.setStatus) as Layer | null;
    if (!leaf) return;   // requireEditableLeaf 已弹标准状态行
  }

  try {
    let ok = true;
    await ctx.withBusy("正在从 Blender 拉取…", async () => {
      const blob = await client!.getTextureData(name);
      const bmp = await createImageBitmap(blob);
      try {
        if (pullTarget === "new") ok = placeBitmapAsNewLayer(bmp, name);
        else overwriteLeaf(leaf as Layer, bmp);
      } finally {
        bmp.close();
      }
    });
    if (ok) ctx.setStatus(`已拉取「${name}」→ ${pullTarget === "new" ? "新图层" : "当前图层"}`);
  } catch (e) {
    ctx.setStatus("拉取失败：" + errMsg(e), true);
  }
}

// ───────────────────── 随文档持久化（.ora webpaintState 搭便车）─────────────────────
// 由 session-state.storeEditorStateToOra / restoreEditorStateFromOra 编排，跟 reference/palette 同款。
export function getBlenderSyncState():
  | { textureName: string; resW: string; resH: string; uploadSource: string; pullTarget: string }
  | undefined {
  if (!built) return undefined;
  return {
    textureName: nameInput.value,
    resW: sizeW.value,
    resH: sizeH.value,
    uploadSource,
    pullTarget,
  };
}
export function applyBlenderSyncState(s?: unknown) {
  if (!built) return;
  const o = (s && typeof s === "object") ? (s as Record<string, unknown>) : {};
  nameInput.value = typeof o.textureName === "string" ? o.textureName : "";
  sizeW.value = typeof o.resW === "string" ? o.resW : "";
  sizeH.value = typeof o.resH === "string" ? o.resH : "";
  uploadSource = o.uploadSource === "active" ? "active" : "merged";
  pullTarget = o.pullTarget === "overwrite" ? "overwrite" : "new";
  syncConfigUI();
}

// 把 uploadSource/pullTarget 反映到 ⋯ 配置的 radio + 行内 sub 标签。
function syncConfigUI() {
  dlSub.textContent = pullTarget === "new" ? "新图层" : "覆盖当前";
  ulSub.textContent = uploadSource === "merged" ? "合并画布" : "当前图层组";
  for (const r of panel.querySelectorAll<HTMLInputElement>('input[name="btpPull"]')) {
    r.checked = r.value === pullTarget;
  }
  for (const r of panel.querySelectorAll<HTMLInputElement>('input[name="btpSrc"]')) {
    r.checked = r.value === uploadSource;
  }
}

// ───────────────────────── 面板 DOM ─────────────────────────

function closeAllPopups() {
  for (const p of panel.querySelectorAll<HTMLElement>(".btp-popup")) p.classList.add("hidden");
}

function wirePopup(wrench: HTMLElement, popup: HTMLElement) {
  wrench.addEventListener("click", (e) => {
    e.stopPropagation();
    const show = popup.classList.contains("hidden");
    closeAllPopups();
    popup.classList.toggle("hidden", !show);
  });
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
}

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
      <span class="float-panel-title">Blender 同步</span>
      <button class="float-panel-close" id="btpClose" type="button" aria-label="关闭">×</button>
    </div>
    <div class="float-panel-body">
      <div class="btp-action-row">
        <button class="btp-btn btp-connbtn" id="btpConnBtn" type="button" data-state="off"></button>
        <button class="menu-item-wrench" id="btpRemoteCfg" type="button" title="远程设备（iPad）配对">⋯</button>
        <div class="menu-config-popup btp-popup btp-popup-wide hidden" id="btpRemotePop">
          <div class="menu-config-section">
            <div class="menu-config-title">远程设备（iPad）配对</div>
            <textarea id="btpOffer" class="btp-area" rows="2" placeholder="粘贴 Blender 的连接码 BTP1:…"></textarea>
            <button class="btp-btn" id="btpPair" type="button">配对</button>
            <div id="btpAnswerRow" hidden>
              <div class="btp-label">把下面响应码贴回 Blender：</div>
              <textarea id="btpAnswer" class="btp-area" rows="2" readonly></textarea>
              <button class="btp-btn" id="btpCopyAnswer" type="button">复制响应码</button>
            </div>
          </div>
        </div>
      </div>
      <div class="btp-row">
        <label class="btp-label" for="btpName">贴图名（= 标识）</label>
        <div class="btp-namerow">
          <input id="btpName" class="btp-input" list="btpTexList" placeholder="image 名字" />
          <datalist id="btpTexList"></datalist>
          <button class="btp-btn btp-sm" id="btpUseSel" type="button" title="用 Blender 当前选中">选中</button>
          <button class="btp-btn btp-sm" id="btpRefresh" type="button" title="刷新贴图列表">刷新</button>
        </div>
      </div>
      <div class="btp-action-row">
        <button class="btp-btn btp-action" id="btpDownload" type="button">
          <span class="btp-action-ic">${ICON_DL}</span>
          <span class="btp-action-label">拉取贴图</span>
          <span class="btp-action-sub" id="btpDownloadSub">新图层</span>
        </button>
        <button class="menu-item-wrench" id="btpDownloadCfg" type="button" title="拉取设置">⋯</button>
        <div class="menu-config-popup btp-popup hidden" id="btpDownloadPop">
          <div class="menu-config-section">
            <div class="menu-config-title">拉到</div>
            <label><input type="radio" name="btpPull" value="new" checked /> 新建图层</label>
            <label><input type="radio" name="btpPull" value="overwrite" /> 覆盖当前图层</label>
          </div>
        </div>
      </div>
      <div class="btp-action-row">
        <button class="btp-btn btp-action primary" id="btpUpload" type="button">
          <span class="btp-action-ic">${ICON_UL}</span>
          <span class="btp-action-label">推送贴图</span>
          <span class="btp-action-sub" id="btpUploadSub">合并画布</span>
        </button>
        <button class="menu-item-wrench" id="btpUploadCfg" type="button" title="推送设置">⋯</button>
        <div class="menu-config-popup btp-popup hidden" id="btpUploadPop">
          <div class="menu-config-section">
            <div class="menu-config-title">推送来源</div>
            <label><input type="radio" name="btpSrc" value="merged" checked /> 合并画布</label>
            <label><input type="radio" name="btpSrc" value="active" /> 当前图层 / 组</label>
          </div>
        </div>
      </div>
      <div class="btp-row">
        <label class="btp-label">尺寸（拉伸贴合，空 = doc 尺寸）</label>
        <div class="btp-sizerow">
          <input id="btpSizeW" class="btp-input" placeholder="宽" inputmode="numeric" />
          <span class="btp-x">×</span>
          <input id="btpSizeH" class="btp-input" placeholder="高" inputmode="numeric" />
          <select id="btpSizePreset" class="btp-sizepreset" aria-label="尺寸预设">
            <option value="">预设…</option>
            <option value="doc">Doc</option>
            <option value="128">128</option>
            <option value="256">256</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
          </select>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // 引用
  connBtn = q("#btpConnBtn");
  offerInput = q("#btpOffer");
  answerRow = q("#btpAnswerRow");
  answerOutput = q("#btpAnswer");
  nameInput = q("#btpName");
  texList = q("#btpTexList");
  sizeW = q("#btpSizeW");
  sizeH = q("#btpSizeH");
  dlSub = q("#btpDownloadSub");
  ulSub = q("#btpUploadSub");

  // 行为接线
  q<HTMLButtonElement>("#btpClose").addEventListener("click", () => togglePanel(false));
  connBtn.addEventListener("click", onConnClick);
  q<HTMLButtonElement>("#btpPair").addEventListener("click", () => { void pairRemote(); });
  q<HTMLButtonElement>("#btpCopyAnswer").addEventListener("click", () => {
    answerOutput.select();
    void navigator.clipboard?.writeText(answerOutput.value).then(
      () => ctx.setStatus("响应码已复制"),
      () => { /* 用户可手动复制选中文本 */ },
    );
  });
  q<HTMLButtonElement>("#btpUseSel").addEventListener("click", () => { void useSelection(); });
  q<HTMLButtonElement>("#btpRefresh").addEventListener("click", () => { void refreshTextureList(); });
  q<HTMLButtonElement>("#btpDownload").addEventListener("click", () => { void pull(); });
  q<HTMLButtonElement>("#btpUpload").addEventListener("click", () => { void push(); });

  // ⋯ 弹层
  wirePopup(q("#btpRemoteCfg"), q("#btpRemotePop"));
  wirePopup(q("#btpDownloadCfg"), q("#btpDownloadPop"));
  wirePopup(q("#btpUploadCfg"), q("#btpUploadPop"));

  // 配置 radio → 更新状态 + sub 标签
  for (const r of panel.querySelectorAll<HTMLInputElement>('input[name="btpPull"]')) {
    r.addEventListener("change", () => { if (r.checked) { pullTarget = r.value === "overwrite" ? "overwrite" : "new"; syncConfigUI(); } });
  }
  for (const r of panel.querySelectorAll<HTMLInputElement>('input[name="btpSrc"]')) {
    r.addEventListener("change", () => { if (r.checked) { uploadSource = r.value === "active" ? "active" : "merged"; syncConfigUI(); } });
  }

  // 分辨率预设下拉 → 同时填两个文本框（"doc" = 清空 = doc 尺寸），随即复位下拉
  const sizePreset = q<HTMLSelectElement>("#btpSizePreset");
  sizePreset.addEventListener("change", () => {
    const v = sizePreset.value;
    if (v === "doc") { sizeW.value = ""; sizeH.value = ""; }
    else if (v) { sizeW.value = v; sizeH.value = v; }
    sizePreset.selectedIndex = 0;
  });

  attachDrag(q<HTMLDivElement>("#btpHead"));
  restorePos();
  built = true;
  setConnState("off");
  syncConfigUI();
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
