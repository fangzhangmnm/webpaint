// 加密的 app 胶水（WebPaint 对 peek 字节的**解释** = 缩略图 PNG；统一密码政策）。
// store 对密码非交互——「弹密码框 + 验证 + 重试」的循环住这里，且**必须在 withBusy 之外调用**
// （busy 遮罩 z 高于 sheet，盖住密码框 = 无限转圈死锁；sheets 护栏也会 throw）。

import { store } from "./app-store.ts";
import { isUnlocked, getPassword, setPassword, onPasswordVerified, promptPassword } from "./crypto-state.ts";

/** 本地加密作品的缩略图（内存密码解得开→PNG Blob；锁定/没有→null）。非交互——批量渲染不弹窗。 */
export async function localPeekThumb(name: string): Promise<Blob | null> {
  const bytes = await store.readPeek(name);
  return bytes && bytes.length ? new Blob([bytes], { type: "image/png" }) : null;
}

/** 云端 byte-range 拉回的密文 peek blob（ENC_PEEK_MIME）→ PNG Blob | null。非交互。 */
export async function decryptCloudPeekThumb(name: string, encBlob: Blob): Promise<Blob | null> {
  const bytes = await store.decryptPeekBytes(name, encBlob);
  return bytes && bytes.length ? new Blob([bytes], { type: "image/png" }) : null;
}

/**
 * 确保 name 的密码在内存且验证过。**必须在 withBusy 之外调用**（要弹密码框）。
 * 内存密码先 verify（统一/per-name），不行就 prompt 循环（错→重问，取消→false）。
 * 验证经 store.verifyPassword（解 peek，便宜、不开 UI、不进 busy）。返回 false = 用户取消。
 */
export async function ensureUnlocked(name: string): Promise<boolean> {
  const cur = getPassword(name);
  if (cur && await store.verifyPassword(name, cur)) return true;
  for (let attempt = 0; ; attempt++) {
    const pw = await promptPassword({
      title: "解锁加密作品",
      message: attempt > 0 ? "密码不对，再试一次" : "输入图库密码。密码只存在内存里，关页即忘。",
    });
    if (pw == null) return false;
    if (await store.verifyPassword(name, pw)) { onPasswordVerified(name, pw); return true; }
  }
}

/**
 * 同上但验一段**明文容器字节**（导入外来加密文件——文件还没进 store，没 name 可查 peek）。
 * 返回验证过的密码（调用方拿去 unsealWith 解；不污染全局，记忆由调用方按落库 name 决定），
 * 取消 → null。**busy 外调用。**
 */
export async function ensureUnlockedForBlob(blob: Blob) {
  const cur = getPassword(null);
  if (cur && await store.verifyContainer(blob, cur)) return cur;
  for (let attempt = 0; ; attempt++) {
    const pw = await promptPassword({
      title: "解锁导入的加密文件",
      message: attempt > 0 ? "密码不对，再试一次" : "这是加密文件。输入它的密码。",
    });
    if (pw == null) return null;
    if (await store.verifyContainer(blob, pw)) return pw;
  }
}

/**
 * 首次加密的密码获取：已解锁 → 复用统一密码（不重复问）；锁定 → 设新密码（输两遍 + 一次性风险提示；
 * 不强制强度）。取消 → null。**不**写入 crypto-state（调用方在 flow.encrypt 成功后才 setPassword）。
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
