// Azure AD App registration for WeebPaint。Phase 2（云同步）会用到 MSAL；
// phase 1 本地持久化暂时不读取这里。
//
// 部署清单（已建好的 SPA app，All Microsoft account users）：
//   - Display name:  WeebPaint
//   - Application (client) ID: 18c496a6-5d86-4ff5-8dd0-67d565480a3e
//   - Object ID:     7ef0ff74-cdcc-44a6-8dca-60ec903fe3aa
//   - Tenant ID:     c1fef054-68f1-48db-9097-61acbe59b8ac
//   - Redirect URIs: SPA × 2（dev http://localhost / prod https://fangzhangmnm.github.io/weebpaint/）
//
// CLIENT_ID 占位时（"REPLACE_ME..."）走纯离线，不去碰 MSAL bundle。
export const CLIENT_ID = "18c496a6-5d86-4ff5-8dd0-67d565480a3e";

// common = 个人 + 组织都能登
export const AUTHORITY = "https://login.microsoftonline.com/common";

// AppFolder = approot 沙盒；offline_access 给 silent refresh token
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];

// 把 sessionName 转成 cloud / IDB key 文件名。phase 1 只有一个 fixed slot
// （"current"），还用不上这个；phase 2 多 session 时再用。
//   "未命名"          → "未命名.ora"
//   "characters/wall" → "characters/wall.ora"
// **裸名的归一化（SSoT）**。sessionFileName = 本函数 + ".ora"。
//
// ⚠ 它**不是单射**：`[\:*?"<>|]+` 整段换成一个 `_`、按段 trim、丢空段。所以
//   a:b / a*b / a_b / a__b 全都塌成 a_b；" a " 和 a 塌成 a；"" 和 "///" 塌成「未命名」。
// 这本身没问题（文件名就是要合法化），**有问题的是「存原始名、比较时才归一」**：
//   gallery 的 item.name 来自 store（已归一），而 app 侧若存着用户敲的原始名，
//   `item.name === activeName` 这类比较就会永久失配。v437 之前有五处这样的比较，
//   最狠的一处让活动文档改名绕过 es.rename() → 盘上文件改了名、编辑器还指着旧身份 →
//   下次 autosave 以 mode:"existing" 把旧身份重建出来 → **两个文件，可见的那个不是正在编辑的那个**。
// → 纪律：**在赋值处归一化**，别在比较处补救。活动名一旦落地就已经是归一形式。
export function sessionBareName(sessionName: string) {
  const segments = (sessionName || "Untitled")   // 防御 fallback（正常路径名字来自 session-state 的 t("nd.untitled")）；config 在 store 上游不引 i18n
    .split("/")
    .map((s: string) => s.replace(/[\\:*?"<>|]+/g, "_").trim())
    .filter(Boolean);
  if (!segments.length) segments.push("Untitled");
  return segments.join("/");
}

// 把 sessionName 转成 cloud / IDB key 文件名。
//   "未命名"          → "未命名.ora"
//   "characters/wall" → "characters/wall.ora"
export function sessionFileName(sessionName: string) {
  return `${sessionBareName(sessionName)}.ora`;
}

// （encSessionFileName 已删 v415：零调用者。app 不再向 store 注入 encFileName——
//   「加密件云端叫 X.ora.zip」这条命名规则整个由库内部持有（见 app-store.ts 的说明）。）

// 云端 path → session name（sessionFileName/encSessionFileName 的逆）。
// 所有「path 去扩展名」的地方都走这里，别再散落 \.ora$ 正则（加密文件是 .zip）。
export function stripSessionExt(path: string) {
  return String(path).replace(/\.(ora|zip)$/i, "");
}
