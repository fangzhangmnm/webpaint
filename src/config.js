// Azure AD App registration for WebPaint。Phase 2（云同步）会用到 MSAL；
// phase 1 本地持久化暂时不读取这里。
//
// 部署清单（已建好的 SPA app，All Microsoft account users）：
//   - Display name:  WebPaint
//   - Application (client) ID: 18c496a6-5d86-4ff5-8dd0-67d565480a3e
//   - Object ID:     7ef0ff74-cdcc-44a6-8dca-60ec903fe3aa
//   - Tenant ID:     c1fef054-68f1-48db-9097-61acbe59b8ac
//   - Redirect URIs: SPA × 2（dev http://localhost / prod https://fangzhangmnm.github.io/webpaint/）
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
export function sessionFileName(sessionName) {
  const segments = (sessionName || "未命名")
    .split("/")
    .map((s) => s.replace(/[\\:*?"<>|]+/g, "_").trim())
    .filter(Boolean);
  if (!segments.length) segments.push("未命名");
  return `${segments.join("/")}.ora`;
}
