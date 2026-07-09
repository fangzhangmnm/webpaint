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

// MSAL 全局由运行时 vendored 脚本（window.msal）加载，无 @types → 整体 any 松类型。
// pca = PublicClientApplication 实例；account = AccountInfo。下面统一用 any 兜（见顶部注释）。
type Msal = any;
type Pca = any;
type Account = any;

// window.msal 由 vendored 脚本注入；用 any 桥接（DOM lib 的 Window 不含 msal）。
declare global {
  interface Window {
    msal?: Msal;
  }
}

interface AuthConfig {
  clientId?: string;
  authority?: string;
  scopes?: string[];
  msalUrl?: string | null;
}

// 配置注入（取代 WebPaint 的 config.js import，去 app 化）。app 调一次 configureOneDriveAuth。
let CLIENT_ID = "";
let AUTHORITY = "https://login.microsoftonline.com/common";
let SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
let MSAL_URL: string | null = null;
export function configureOneDriveAuth({ clientId, authority, scopes, msalUrl }: AuthConfig = {}): void {
  if (clientId) CLIENT_ID = clientId;
  if (authority) AUTHORITY = authority;
  if (scopes) SCOPES = scopes;
  if (msalUrl != null) {   // 浏览器相对路径（vendored 脚本）→ 绝对；node 里 = null
    MSAL_URL = (typeof document !== "undefined" && document.baseURI)
      ? new URL(msalUrl, document.baseURI).href : null;
  }
}

export function isAuthConfigured(): boolean {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}

// MSAL_URL 由 configureOneDriveAuth 设（app 传 vendored 脚本相对路径，document.baseURI 解绝对）。
let msalLoadPromise: Promise<Msal> | null = null;
let pca: Pca = null;
let activeAccount: Account = null;
let initPromise: Promise<AuthState> | null = null;

// initAuth / getAuthState 返回的状态。
interface AuthState {
  signedIn: boolean;
  account: Account;
  notConfigured?: boolean;
  probing?: boolean;
  probedAccount?: Account;
}

// ---- auth 状态可观察 seam ----
// 单一源 = activeAccount。**每个**转变（登录回来 / 后台 silent / 登出 / 过期）都 _emitAuth。
// UI 订阅一次（onAuthChanged）→ 永不漂移；isSignedIn() 是派生读。治"按钮不变蓝"+ F2 过期假登录。
type AuthSub = (st: AuthState) => void;
const _authSubs = new Set<AuthSub>();
export function onAuthChanged(cb: AuthSub): () => void { _authSubs.add(cb); return () => _authSubs.delete(cb); }
export function getAuthState(): AuthState { return { signedIn: !!activeAccount, account: activeAccount }; }
function _emitAuth(): void {
  const st = getAuthState();
  for (const cb of _authSubs) { try { cb(st); } catch (_) {} }
  try { if (typeof window !== "undefined") window.dispatchEvent(new Event("wp:auth-changed")); } catch (_) {}
}

function loadScript(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function loadScriptWithRetry(url: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { await loadScript(url); return; }
    catch (e) {
      lastErr = e;
      console.warn(`MSAL load attempt ${i + 1}/${attempts} failed`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`MSAL load failed ${url}: ${(lastErr as Error | undefined)?.message}`);
}

function loadMsal(): Promise<Msal> {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    await loadScriptWithRetry(MSAL_URL as string);
    if (window.msal) return window.msal;
    msalLoadPromise = null;
    throw new Error("MSAL loaded but window.msal didn't appear");
  })().catch((e) => { msalLoadPromise = null; throw e; });
  return msalLoadPromise;
}

export async function initAuth(): Promise<AuthState> {
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
      _emitAuth();                                  // 登录 redirect 回来 → 通知 UI（按钮变蓝）
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
async function _probeSilent(account: Account): Promise<void> {
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account });
    pca.setActiveAccount(account);
    activeAccount = account;
    _emitAuth();                                    // 后台 silent 成功 → 通知 UI
  } catch (_) { /* 拿不到 token = 未真登录；UI 保持未登录，用户可显式登录 */ }
}

export async function signIn(): Promise<unknown> {
  // **iOS 关键**：loginRedirect 必须在同步 user-gesture（点击）里调，**前面不能有 await**，
  // 否则 iOS Safari 把它当非手势导航静默拦截（→ 不弹登录框）。
  // interaction 状态由 boot initAuth 的 handleRedirectPromise 清（silent 探测已移后台不占 interaction），
  // 所以点击时 pca 通常已就绪，直接同步 loginRedirect。
  if (!pca) await initAuth();                  // 仅 boot 还没建 pca 的极少数情况才等（会丢 gesture，但罕见）
  return pca.loginRedirect({ scopes: SCOPES }); // 同步调用，保住 iOS user-gesture
}

export async function signOut(): Promise<void> {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  _emitAuth();                                      // 登出 → 立即通知 UI（按钮变灰）
  try { await pca.clearCache({ account }); }
  catch (e) { console.warn("clearCache failed:", e); }
  try { pca.setActiveAccount(null); } catch (_) {}
}

export async function getToken(): Promise<string> {
  if (!pca || !activeAccount) throw new Error("Not signed in");
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return result.accessToken;
  } catch (e) {
    // silent 失败 = token 过期/失效 → 清 activeAccount + 通知 UI（按钮变灰，回到"未登录"）。
    // **绝不在此 acquireTokenRedirect**：getToken 只在后台 graph 请求里被调；后台数据同步
    //   触发交互式跳转 = boot 重定向循环（silent 失败→跳转→重载→再 silent 失败…一直转）/
    //   阅读中被劫持导航。交互式重新登录只走显式 signIn()（user-gesture loginRedirect），
    //   后台同步在此降级为离线（调用方 try/catch 收成 offline，本地仍可读、脏不丢）。
    activeAccount = null;
    _emitAuth();
    throw e;
  }
}

export function getActiveAccount(): Account { return activeAccount; }
export function isSignedIn(): boolean { return !!activeAccount; }

// 当从离线变成在线时调一次。boot 时 acquireTokenSilent 因网络抛错 → activeAccount
// 留空 → 后面有网了 isSignedIn 也还是 false。这个函数显式 retry 一次 silent，
// 成功就把 activeAccount 设上，UI 该刷新 / cloud list 该重拉的就跟着走。
export async function retrySilentSignIn(): Promise<boolean> {
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
    _emitAuth();                                    // online 后 silent 补登 → 通知 UI
    return true;
  } catch (_) {
    return false;
  }
}
