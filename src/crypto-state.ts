// WebPaint 的密码**政策**模块（ADR-0012 / encryption-model：WebPaint = unified password）。
// store 对密码非交互（seam 只要 getPassword）；本模块持有内存密码 + 弹窗 + 记忆政策。
//   getPassword(name)        → store seam 唯一接口：统一图库密码（per-name 覆盖兜底）
//   promptPassword(opts)     → in-app 输入 sheet（弹窗实现由 composition root 注入，无 DOM 依赖）
//   onPasswordVerified(name) → UI 解锁循环验证通过后调（全局空着就上位为全局；否则记 per-name）
// 「弹框 + 验证 + 重试」的循环在 enc-thumbs.ensureUnlocked（**必须在 withBusy 之外**——busy 遮罩盖
//   密码框会死锁，sheets 护栏也会 throw）。**密码永不持久化**：只活内存，关 tab / 锁定即忘。

/** 密码输入弹窗的注入形状（由 composition root 提供，无 DOM 依赖）。 */
export interface PromptOpts { title?: string; message?: string; }
type PasswordPrompt = (opts: PromptOpts) => Promise<string | null>;
type LockChangeSub = (unlocked: boolean) => void;

let _password: string | null = null;                 // 统一图库密码
const _perName = new Map<string, string>();          // 别的密码的文件（导入件）的 per-name 覆盖；锁定时一并清
let _prompt: PasswordPrompt | null = null;           // async ({title, message}) => string | null（取消）
const _subs = new Set<LockChangeSub>();

function _notify() { for (const cb of _subs) { try { cb(_password != null); } catch (_) {} } }

export function setPasswordPrompt(fn: PasswordPrompt) { _prompt = fn; }
export function isUnlocked() { return _password != null; }
export function setPassword(pw: string | null) { _password = pw || null; _notify(); }
/** 锁定 = 忘掉一切密码（内存清除）。加密文件回到锁样式；保存路径会明确报 LOCKED 而非静默。 */
export function lock() { _password = null; _perName.clear(); _notify(); }
/** 锁态变化订阅（图库刷新用）。返回退订函数。 */
export function onLockChange(cb: LockChangeSub) { _subs.add(cb); return () => _subs.delete(cb); }

/** 弹一次密码输入（不入库、不验证）。app 没注入 prompt → throw（组装错误，早炸）。 */
export async function promptPassword(opts: PromptOpts = {}) {
  if (!_prompt) throw new Error("密码输入未接线（setPasswordPrompt）");
  const pw = await _prompt(opts);
  return pw == null || pw === "" ? null : pw;
}

// ---- store crypt seam（app-store 装配只注入 getPassword）----

export function getPassword(name: string | null): string | null {
  if (name != null && _perName.has(name)) return _perName.get(name)!;
  return _password;
}

export function onPasswordVerified(name: string, pw: string) {
  // 统一密码模型：全局还空着 → 这个验证过的密码上位为全局；
  // 全局已有但这个文件用别的密码（导入件）→ 记 per-name 覆盖，全局不动。
  if (_password == null) { _password = pw; _notify(); }
  else if (pw !== _password) _perName.set(name, pw);
}
