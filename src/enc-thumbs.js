// 加密缩略图的图库胶水（WebPaint 对 peek 字节的**解释** = 缩略图 PNG）。
// 机制全在 store（readPeek / decryptPeekBytes：尾片路由、MAGIC 扫描、密码循环、验证回忆）；
// 这里只做两件 app 的事：把解出的不透明 peek 字节包成 image/png Blob 给 <img>，
// 和「设新密码」的双输 UX（统一密码 = WebPaint 的 per-app 选择）。

import { store } from "./app-store.js";
import { isUnlocked, getPassword, promptPassword } from "./crypto-state.js";

/** 本地加密作品的缩略图（解锁→PNG Blob；锁定/没有→null）。interactive=true = 点锁解锁动作
 *（store 进 requestPassword 循环 + 验证 + onPasswordVerified 记忆）。 */
export async function localPeekThumb(name, { interactive = false } = {}) {
  const bytes = await store.readPeek(name, { interactive });
  return bytes && bytes.length ? new Blob([bytes], { type: "image/png" }) : null;
}

/** 云端 byte-range 拉回的密文 peek blob（ENC_PEEK_MIME）→ PNG Blob | null。 */
export async function decryptCloudPeekThumb(name, encBlob, { interactive = false } = {}) {
  const bytes = await store.decryptPeekBytes(name, encBlob, { interactive });
  return bytes && bytes.length ? new Blob([bytes], { type: "image/png" }) : null;
}

/**
 * 首次加密的密码获取：已解锁 → 复用统一密码（unified model，不重复问）；
 * 锁定 → 设新密码（输两遍 + 一次性风险提示；不强制强度——安全性是用户自己的责任）。
 * 取消 → null。**不**写入 crypto-state（调用方在 flow.encrypt 成功后才 setPassword）。
 */
export async function ensureNewPassword() {
  if (isUnlocked()) return getPassword(null);
  for (let round = 0; round < 3; round++) {
    const p1 = await promptPassword({
      title: "设置图库密码",
      message: round > 0
        ? "两次输入不一致，重新设置"
        : "整个图库共用这一个密码。忘记 = 内容永久找不回（没有任何后门）；太短的密码可被暴力破解。加密文件用 7-Zip 输此密码也能打开。",
    });
    if (p1 == null) return null;
    const p2 = await promptPassword({ title: "再输一遍确认", message: "两次输入需一致" });
    if (p2 == null) return null;
    if (p1 === p2) return p1;
  }
  return null;   // 连错三轮 → 退出，别困住用户
}
