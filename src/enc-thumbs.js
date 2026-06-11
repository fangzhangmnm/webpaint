// 加密缩略图的图库胶水（浏览器专用：摸 IDB / Blob）。
// 机制在 crypto-container（纯），密码态在 crypto-state（无 DOM）；这里只做三件事：
//   ① 本地加密作品 → 从 IDB blob 尾部切 96KB（零网络）解出预览
//   ② 云端 byte-range 拉回的加密 thumb blob（ENC_THUMB_MIME 标记）→ 解出预览
//   ③ 图库的「解锁」交互（可带验证字节：解得开某个 thumb = 密码对）
// 解出的 PNG 只活在内存 objectURL —— 永不写回 IDB（加密文件的明文 thumb 不落盘）。

import { getSession } from "./storage.js";
import {
  scanEncThumbFromEnd, decryptThumbParsed, THUMB_TAIL_WINDOW,
} from "./crypto-container.js";
import { getPassword, isUnlocked, setPassword, promptPassword } from "./crypto-state.js";

/** 本地加密作品的容器尾部切片（拿来解 thumb / 当解锁验证字节）。没有 → null */
export async function localEncTail(name) {
  try {
    const pkg = await getSession(name);
    if (!pkg || !pkg.ora) return null;
    return pkg.ora.slice(Math.max(0, pkg.ora.size - THUMB_TAIL_WINDOW));
  } catch (_) { return null; }
}

/** 解密一份「带尾部加密 thumb 的字节」（容器尾切片 / 云端 enc-thumb blob）→ PNG Blob。
 *  锁定 / 密码不对 / 没扫到 → null（图库显示锁样式，不抛）。 */
export async function decryptEncThumbBlob(blob) {
  const pw = getPassword();
  if (!pw || !blob) return null;
  try {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    const parsed = scanEncThumbFromEnd(u8);
    if (!parsed) return null;
    const png = await decryptThumbParsed(parsed, pw);
    return new Blob([png], { type: "image/png" });
  } catch (_) { return null; }
}

/**
 * 图库「解锁」交互：弹密码 → 有验证字节就先验（解 thumb，AES-GCM tag 即验证器），
 * 错了带「密码不对」重问；对了记为统一密码。取消 → false。
 * 没有验证字节（如本地一件加密的都没有）→ 接受输入，错密码在用到时自然暴露并重问。
 */
export async function unlockInteractive(validateBlob = null) {
  let parsed = null;
  if (validateBlob) {
    try { parsed = scanEncThumbFromEnd(new Uint8Array(await validateBlob.arrayBuffer())); } catch (_) {}
  }
  for (let attempt = 0; ; attempt++) {
    const pw = await promptPassword({
      title: "解锁加密作品",
      message: attempt > 0 ? "密码不对，再试一次" : "输入图库密码。密码只存在内存里，关页即忘。",
    });
    if (pw == null) return false;
    if (parsed) {
      try { await decryptThumbParsed(parsed, pw); } catch (_) { continue; }
    }
    setPassword(pw);
    return true;
  }
}

/**
 * 首次加密的密码获取：已解锁 → 直接复用统一密码（unified model，不重复问）；
 * 锁定 → 设新密码（输两遍 + 一次性风险提示，非阻断不强制强度——安全性是用户自己的责任）。
 * 取消 → null。**不**写入 crypto-state（调用方加密成功后才 setPassword）。
 */
export async function ensureNewPassword() {
  if (isUnlocked()) return getPassword();
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
