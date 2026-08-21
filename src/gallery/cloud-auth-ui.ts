// 职责（单一）：云账号 UI —— gallery header 右侧的云 icon 按钮 + 账号 popup
// （登录 / 退出 / 刷新）+ 云 auth 状态图标。一颗云图标 + 状态色：未登录灰，已登录蓝勾；
// 点开 popup 显示账号 + 登录/退出；刷新按钮只在登录后显示。
//
// 不含：anchorPopupToBtn（多 popup 共用，留 app）、document-pointerdown 关 popup
// （三个 popup 共用，留 app）、gallery 自身的云列表/refresh 逻辑。
//
// auth 是公共面：直接 import 自 app-store.js。setStatus / updateSaveStatus / gallery
// 经 ctx 注册表晚绑（拆分期权宜）。

import { t, tLatin } from "../i18n/index.ts";
import type { AppContext } from "../app-context.ts";
import { els } from "../els.ts";
import { iconHtml } from "../ui/icon.ts";
import {
  isSignedIn, isAuthConfigured, signIn, signOut,
  getActiveAccount, retrySilentSignIn,
} from "../app-store.ts";

let setStatus: AppContext["setStatus"];
let updateSaveStatus: AppContext["updateSaveStatus"];
let gallery: AppContext["gallery"];

const ICON_CLOUD_OUT = iconHtml("cloud");
const ICON_CLOUD_IN = iconHtml("cloud-synced");

export function updateCloudAuthUI() {
  const signed = isSignedIn();
  const configured = isAuthConfigured();
  const offline = navigator.onLine === false;     // navigator.onLine=undefined 当 true
  if (signed) {
    const acc = getActiveAccount();
    els.cloudIconBtn.innerHTML = ICON_CLOUD_IN;
    els.cloudIconBtn.dataset.cloudState = "signedin";
    const who = acc?.username || acc?.name || t("cf.signedIn");
    els.cloudIconBtn.title = offline ? t("cf.cloudAccountOfflineTitle", { who }) : t("cf.cloudAccountTitle", { who });
    els.cloudAccountInfo.textContent = offline ? t("cf.cloudAccountOfflineInfo", { who }) : t("cf.cloudAccountInfo", { who });
    els.cloudSignInBtn.classList.add("hidden");
    els.cloudSignOutBtn.classList.remove("hidden");
    els.cloudRefreshBtn.classList.toggle("hidden", offline);   // 离线时藏刷新（按了没意义）
  } else {
    els.cloudIconBtn.innerHTML = ICON_CLOUD_OUT;
    els.cloudIconBtn.dataset.cloudState = configured ? "out" : "unconfigured";
    if (offline && configured) {
      els.cloudIconBtn.title = tLatin("cf.cloudOfflineTitle");
      els.cloudAccountInfo.textContent = t("cf.cloudOffline");
    } else {
      els.cloudIconBtn.title = configured ? t("cf.cloudNotSignedInTitle") : t("cf.cloudNotConfigured");
      els.cloudAccountInfo.textContent = configured ? t("cf.cloudNotSignedIn") : t("cf.cloudNotConfigured");
    }
    els.cloudSignInBtn.classList.toggle("hidden", !configured || offline);    // 离线时登录按钮无意义
    els.cloudSignOutBtn.classList.add("hidden");
    els.cloudRefreshBtn.classList.add("hidden");
  }
  // 编辑器主菜单登录项（v0.6.22 menuSignIn）已删 2026-08-21：编辑器内登录统一走 smart save 的
  //   「现在登录同步？」sheet（topbar-menu.smartSaveAndPush，同「未登录+已配置+在线」判据）。
  updateSaveStatus();
}

export function initCloudAuthUI(ctx: AppContext) {
  ({ setStatus, updateSaveStatus, gallery } = ctx);

  // 云 icon popup（anchorPopupToBtn 在 app；toggle 其它 popup 也在 app 的 handler 里——
  // 故云 icon 的 click 仍由 app 绑定 anchorPopupToBtn/互斥关闭。本模块只接登录/退出/刷新动作）。

  els.cloudSignInBtn.addEventListener("click", async () => {
    els.cloudAccountPopup.classList.add("hidden");
    if (!isAuthConfigured()) { setStatus(t("cf.notConfiguredClient")); return; }
    try { await signIn(); } catch (e) { setStatus(t("cf.signInFailed", { err: String((e as Error)?.message || e) })); }
  });
  els.cloudSignOutBtn.addEventListener("click", async () => {
    els.cloudAccountPopup.classList.add("hidden");
    try { await signOut(); } catch (_) {}
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
