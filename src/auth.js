// MSAL.js 包了一层。模式 = JustReadBooks，几乎 1:1。
//
// 关键决策：
// - MSAL 整包 vendor 到 src/vendor/msal/。本地路径，无 CDN 依赖。
//   早期兄弟项目（webxiaoheiwu / justreadpapers）走 CDN，新项目（RealHome / JustReadBooks）改 vendor，
//   AtlasMaker 跟 vendor 路线（更稳，version 跟着 commit）。
// - 懒加载：CLIENT_ID 是占位符就不去 load script，纯离线。
// - 同 origin 多 app 会共用 localStorage 里的 account cache。silent probe 是过滤：
//   有 account 不代表本 app 有 token（本 app 可能从没授权过）。
// - signOut() 只清本 app cache（clearCache），不 logoutRedirect 把用户 Outlook 一起踢掉。

import { CLIENT_ID, AUTHORITY, SCOPES } from "./config.js";

export function isAuthConfigured() {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}

const MSAL_URL = new URL("./vendor/msal/msal-browser.min.js", import.meta.url).href;

let msalLoadPromise = null;
let pca = null;
let activeAccount = null;
let initPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function loadScriptWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { await loadScript(url); return; }
    catch (e) {
      lastErr = e;
      console.warn(`MSAL load attempt ${i + 1}/${attempts} failed`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`MSAL load failed ${url}: ${lastErr?.message}`);
}

function loadMsal() {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    await loadScriptWithRetry(MSAL_URL);
    if (window.msal) return window.msal;
    msalLoadPromise = null;
    throw new Error("MSAL loaded but window.msal didn't appear");
  })().catch((e) => { msalLoadPromise = null; throw e; });
  return msalLoadPromise;
}

export async function initAuth() {
  if (!isAuthConfigured()) {
    return { signedIn: false, account: null, notConfigured: true };
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msal = await loadMsal();
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname,
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
      },
    });
    await pca.initialize();

    let response = null;
    try { response = await pca.handleRedirectPromise(); }
    catch (e) { console.warn("handleRedirectPromise failed:", e); }

    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      return { signedIn: true, account: activeAccount };
    }

    const cached = pca.getAllAccounts();
    if (cached.length === 0) return { signedIn: false, account: null };

    // 同 origin cache leak 过滤：拿过本 app 的 token 才算真登录
    try {
      await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
      pca.setActiveAccount(cached[0]);
      activeAccount = cached[0];
      return { signedIn: true, account: activeAccount };
    } catch (_) {
      return { signedIn: false, account: null, probedAccount: cached[0] };
    }
  })().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

export async function signIn() {
  if (!pca) await initAuth();
  return pca.loginRedirect({ scopes: SCOPES });
}

export async function signOut() {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  try { await pca.clearCache({ account }); }
  catch (e) { console.warn("clearCache failed:", e); }
  try { pca.setActiveAccount(null); } catch (_) {}
}

export async function getToken() {
  if (!pca || !activeAccount) throw new Error("Not signed in");
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return result.accessToken;
  } catch (e) {
    // silent 失败 → 重定向到登录页（一般是 token 过期）
    await pca.acquireTokenRedirect({ scopes: SCOPES });
    throw e;
  }
}

export function getActiveAccount() { return activeAccount; }
export function isSignedIn() { return !!activeAccount; }
