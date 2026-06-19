// 职责（单一）：云账号 UI —— gallery header 右侧的云 icon 按钮 + 账号 popup
// （登录 / 退出 / 刷新）+ 云 auth 状态图标。一颗云图标 + 状态色：未登录灰，已登录蓝勾；
// 点开 popup 显示账号 + 登录/退出；刷新按钮只在登录后显示。
//
// 不含：anchorPopupToBtn（多 popup 共用，留 app）、document-pointerdown 关 popup
// （三个 popup 共用，留 app）、gallery 自身的云列表/refresh 逻辑。
//
// auth 是公共面：直接 import 自 app-store.js。setStatus / updateSaveStatus / gallery
// 经 ctx 注册表晚绑（拆分期权宜）。

import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import {
  isSignedIn, isAuthConfigured, signIn, signOut,
  getActiveAccount, retrySilentSignIn, setLastSessionSignedIn,
} from "./app-store.js";

let setStatus: AppContext["setStatus"];
let updateSaveStatus: AppContext["updateSaveStatus"];
let gallery: AppContext["gallery"];

const ICON_CLOUD_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const ICON_CLOUD_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';

export function updateCloudAuthUI() {
  const signed = isSignedIn();
  const configured = isAuthConfigured();
  const offline = navigator.onLine === false;     // navigator.onLine=undefined 当 true
  if (signed) {
    const acc = getActiveAccount();
    els.cloudIconBtn.innerHTML = ICON_CLOUD_IN;
    els.cloudIconBtn.dataset.cloudState = "signedin";
    const who = acc?.username || acc?.name || "已登录";
    els.cloudIconBtn.title = offline ? `云端：${who}（离线，无法推 / 拉）` : `云端：${who}（点开账号菜单）`;
    els.cloudAccountInfo.textContent = offline ? `云端：${who}（离线）` : `云端：${who}`;
    els.cloudSignInBtn.classList.add("hidden");
    els.cloudSignOutBtn.classList.remove("hidden");
    els.cloudRefreshBtn.classList.toggle("hidden", offline);   // 离线时藏刷新（按了没意义）
  } else {
    els.cloudIconBtn.innerHTML = ICON_CLOUD_OUT;
    els.cloudIconBtn.dataset.cloudState = configured ? "out" : "unconfigured";
    if (offline && configured) {
      els.cloudIconBtn.title = "云端：离线（无法登录 / 同步；本地图库正常）";
      els.cloudAccountInfo.textContent = "云端：离线";
    } else {
      els.cloudIconBtn.title = configured ? "云端：未登录（点开登录）" : "云端：未配置";
      els.cloudAccountInfo.textContent = configured ? "云端：未登录" : "云端：未配置";
    }
    els.cloudSignInBtn.classList.toggle("hidden", !configured || offline);    // 离线时登录按钮无意义
    els.cloudSignOutBtn.classList.add("hidden");
    els.cloudRefreshBtn.classList.add("hidden");
  }
  updateSaveStatus();
}

export function initCloudAuthUI(ctx: AppContext) {
  ({ setStatus, updateSaveStatus, gallery } = ctx);

  // 云 icon popup（anchorPopupToBtn 在 app；toggle 其它 popup 也在 app 的 handler 里——
  // 故云 icon 的 click 仍由 app 绑定 anchorPopupToBtn/互斥关闭。本模块只接登录/退出/刷新动作）。

  els.cloudSignInBtn.addEventListener("click", async () => {
    els.cloudAccountPopup.classList.add("hidden");
    if (!isAuthConfigured()) { setStatus("尚未配置 OneDrive 客户端"); return; }
    try { await signIn(); setLastSessionSignedIn(true); } catch (e) { setStatus("登录失败：" + String((e as Error)?.message || e)); }
  });
  els.cloudSignOutBtn.addEventListener("click", async () => {
    els.cloudAccountPopup.classList.add("hidden");
    try { await signOut(); } catch (_) {}
    setLastSessionSignedIn(false);    // 显式登出 → 下次不问
    updateCloudAuthUI();
    gallery.refresh();
  });
  els.cloudRefreshBtn.addEventListener("click", async () => {
    // 离线 → 在线 后第一次按"刷新"：若未签到但有缓存账号，silent retry 一次
    if (!isSignedIn() && navigator.onLine !== false) {
      await retrySilentSignIn();
      updateCloudAuthUI();
    }
    gallery.refresh();
  });
}
