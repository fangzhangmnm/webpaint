// WebPaint 的密码**政策**模块（ADR-0012 / encryption-model：WebPaint = unified password）。
// 加密机制全在 store 深模块；这里只回答 store 的 crypt seam 三问：
//   getPassword(name)        → 统一图库密码（per-name 覆盖表兜底——别的库导入的文件密码可以不同）
//   requestPassword(name)    → in-app 输入 sheet（弹窗实现由 composition root 注入，无 DOM 依赖）
//   onPasswordVerified(name) → store 验证通过后回来记忆（全局空着就上位为全局；否则记 per-name）
// **密码永不持久化**：只活在这个模块的变量里，关 tab / 锁定即忘。

let _password = null;                 // 统一图库密码
const _perName = new Map();           // 别的密码的文件（导入件）的 per-name 覆盖；锁定时一并清
let _prompt = null;                   // async ({title, message}) => string | null（取消）
const _subs = new Set();

function _notify() { for (const cb of _subs) { try { cb(_password != null); } catch (_) {} } }

export function setPasswordPrompt(fn) { _prompt = fn; }
export function isUnlocked() { return _password != null; }
export function setPassword(pw) { _password = pw || null; _notify(); }
/** 锁定 = 忘掉一切密码（内存清除）。加密文件回到锁样式；保存路径会明确报 LOCKED 而非静默。 */
export function lock() { _password = null; _perName.clear(); _notify(); }
/** 锁态变化订阅（图库刷新用）。返回退订函数。 */
export function onLockChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }

/** 弹一次密码输入（不入库、不验证）。app 没注入 prompt → throw（组装错误，早炸）。 */
export async function promptPassword(opts = {}) {
  if (!_prompt) throw new Error("密码输入未接线（setPasswordPrompt）");
  const pw = await _prompt(opts);
  return pw == null || pw === "" ? null : pw;
}

// ---- store crypt seam 的三件（app-store 装配时接入）----

export function getPassword(name) {
  if (name != null && _perName.has(name)) return _perName.get(name);
  return _password;
}

export async function requestPassword(name, { retry } = {}) {
  return await promptPassword({
    title: "解锁加密作品",
    message: retry
      ? "密码不对，再试一次"
      : `这是加密作品${name ? `（${name}）` : ""}。密码只存在内存里，关页即忘。`,
  });
}

export function onPasswordVerified(name, pw) {
  // 统一密码模型：全局还空着 → 这个验证过的密码上位为全局；
  // 全局已有但这个文件用别的密码（导入件）→ 记 per-name 覆盖，全局不动。
  if (_password == null) { _password = pw; _notify(); }
  else if (pw !== _password) _perName.set(name, pw);
}
