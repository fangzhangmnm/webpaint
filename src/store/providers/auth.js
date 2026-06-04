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

// 配置注入（取代 WebPaint 的 config.js import，去 app 化）。app 调一次 configureOneDriveAuth。
let CLIENT_ID = "";
let AUTHORITY = "https://login.microsoftonline.com/common";
let SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
let MSAL_URL = null;
export function configureOneDriveAuth({ clientId, authority, scopes, msalUrl } = {}) {
  if (clientId) CLIENT_ID = clientId;
  if (authority) AUTHORITY = authority;
  if (scopes) SCOPES = scopes;
  if (msalUrl != null) {   // 浏览器相对路径（vendored 脚本）→ 绝对；node 里 = null
    MSAL_URL = (typeof document !== "undefined" && document.baseURI)
      ? new URL(msalUrl, document.baseURI).href : null;
  }
}

export function isAuthConfigured() {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}

// MSAL_URL 由 configureOneDriveAuth 设（app 传 vendored 脚本相对路径，document.baseURI 解绝对）。
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

    // silent token 探测**移出阻塞 init** → 后台跑（F4）。iOS 上 acquireTokenSilent 的 iframe 会卡住；
    // 若在此 await，MSAL interaction 状态被一直占着 → 用户点登录的 loginRedirect 撞 interaction_in_progress。
    _probeSilent(cached[0]);
    return { signedIn: false, account: null, probing: true, probedAccount: cached[0] };
  })().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

// 后台 silent token 探测：成功 → 设 activeAccount + 广播。绝不阻塞 init / sign-in（iOS iframe 卡不要紧）。
async function _probeSilent(account) {
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account });
    pca.setActiveAccount(account);
    activeAccount = account;
    try { if (typeof window !== "undefined") window.dispatchEvent(new Event("wp:auth-changed")); } catch (_) {}
  } catch (_) { /* 拿不到 token = 未真登录；UI 保持未登录，用户可显式登录 */ }
}

export async function signIn() {
  // 先等 init（含 handleRedirectPromise）跑完——它清掉 MSAL 的 interaction 状态。silent 探测已移后台不阻塞。
  try { await initAuth(); } catch (_) {}
  try {
    return await pca.loginRedirect({ scopes: SCOPES });
  } catch (e) {
    // 兜底：仍撞 interaction_in_progress（上一次 redirect 没收尾）→ 等一拍再试一次。
    if (e && (e.errorCode === "interaction_in_progress" || /interaction.*progress/i.test(e.message || ""))) {
      await new Promise((r) => setTimeout(r, 400));
      return pca.loginRedirect({ scopes: SCOPES });
    }
    throw e;
  }
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

// 当从离线变成在线时调一次。boot 时 acquireTokenSilent 因网络抛错 → activeAccount
// 留空 → 后面有网了 isSignedIn 也还是 false。这个函数显式 retry 一次 silent，
// 成功就把 activeAccount 设上，UI 该刷新 / cloud list 该重拉的就跟着走。
export async function retrySilentSignIn() {
  if (activeAccount) return true;                    // 已签到
  if (!isAuthConfigured()) return false;
  if (!pca) {
    try { await initAuth(); } catch (_) { return false; }
  }
  if (!pca) return false;
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return false;
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    return true;
  } catch (_) {
    return false;
  }
}
