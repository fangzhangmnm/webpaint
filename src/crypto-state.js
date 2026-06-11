// 统一图库密码的内存态（ADR-0012 / encryption-model：WebPaint = unified password）。
// **密码永不持久化**：只活在这个模块的变量里，关 tab 即忘。无 DOM —— 弹窗由 app 注入
// （setPasswordPrompt，composition root 接 sheets 的 in-app 输入框，守「无系统对话框」红线）。
//
// 验证策略：没有全局 verifier 文件（不新增同步面）。密码的正确性在**用的那一刻**验 ——
//   payload 靠 WinZip-AES header 的 2 字节 verifier（zip.js 错密码快速 throw）；
//   thumb 靠 AES-GCM tag（解不开 = 密码错）。错了 lock() + 重问。

import { unpackContainer } from "./crypto-container.js";

let _password = null;
let _prompt = null;          // async ({title, message}) => string | null（取消）
const _subs = new Set();

function _notify() { for (const cb of _subs) { try { cb(_password != null); } catch (_) {} } }

export function setPasswordPrompt(fn) { _prompt = fn; }
export function getPassword() { return _password; }
export function isUnlocked() { return _password != null; }
export function setPassword(pw) { _password = pw || null; _notify(); }
/** 锁定 = 忘掉密码（内存清除）。加密文件回到锁样式；已打开的加密画保存会明确报错而非静默。 */
export function lock() { _password = null; _notify(); }
/** 锁态变化订阅（图库刷新用）。返回退订函数。 */
export function onLockChange(cb) { _subs.add(cb); return () => _subs.delete(cb); }

/** 弹一次密码输入（不入库、不验证）。app 没注入 prompt → throw（组装错误，早炸）。 */
export async function promptPassword(opts = {}) {
  if (!_prompt) throw new Error("密码输入未接线（setPasswordPrompt）");
  const pw = await _prompt(opts);
  return pw == null || pw === "" ? null : pw;
}

/**
 * 交互式解包加密容器：内存密码先试，不行就弹窗循环（错→「密码不对」重问；取消→throw）。
 * 验证通过的密码自动记为统一密码。这是打开加密文件的唯一入口（ora.js decode 用）。
 */
export async function unpackContainerInteractive(blob) {
  for (let attempt = 0; ; attempt++) {
    let pw = getPassword();
    let fromPrompt = false;
    if (!pw) {
      pw = await promptPassword({
        title: "解锁加密作品",
        message: attempt > 0 ? "密码不对，再试一次" : "这是加密作品。密码只存在内存里，关页即忘。",
      });
      if (pw == null) throw new Error("已取消（需要密码才能打开）");
      fromPrompt = true;
    }
    try {
      const res = await unpackContainer(blob, pw);
      setPassword(pw);
      return res;
    } catch (e) {
      lock();   // 内存密码失效（别的库的密码 / 改过）或输错 → 清掉，循环重问
      if (!fromPrompt) continue;
    }
  }
}
