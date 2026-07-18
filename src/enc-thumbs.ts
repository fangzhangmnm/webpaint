// 加密的 app 胶水（WebPaint 对 peek 字节的**解释** = 缩略图 PNG；统一密码政策）。
// store 对密码非交互——「弹密码框 + 验证 + 重试」的循环住这里，且**必须在 withBusy 之外调用**
// （busy 遮罩 z 高于 sheet，盖住密码框 = 无限转圈死锁；sheets 护栏也会 throw）。

import { store } from "./app-store.ts";
import { sessionFileName } from "./config.ts";   // 边界：裸 item.name → 库全名（薄库身份=X.ora）
import { SUFFIX_BYTES, THUMB_PATH } from "./cloud-thumbs.ts";
import { isUnlocked, getPassword, setPassword, onPasswordVerified, promptPassword } from "./crypto-state.ts";

// 边界：app 传裸 session 名，库身份是全名 → sessionFileName 统一转（与 session-state/gallery 一致）。
const encFile = (name: string) => store.file(sessionFileName(name), { isZip: true, mode: "existing" });

/** 本地加密作品的缩略图（内存密码解得开→PNG Blob；锁定/没有→null）。非交互——批量渲染不弹窗。 */
export async function localPeekThumb(name: string): Promise<Blob | null> {
  const zf = encFile(name);
  const peek = await zf.getPeek({ bytesLength: SUFFIX_BYTES, zipEntry: THUMB_PATH });   // 加密件 → 密文 peek blob（ENC_PEEK_MIME）
  return peek ? await zf.decryptPeek(peek) : null;                                      // 内存密码非交互解；锁定→null。明文缩略图不落任何缓存（结果仅 object URL）
}

/** 云端 byte-range 拉回的密文 peek blob（ENC_PEEK_MIME，缓存原样存）→ 明文 PNG Blob | null。非交互，不再重取（直接解传入密文）。 */
export async function decryptCloudPeekThumb(name: string, encBlob: Blob): Promise<Blob | null> {
  return await encFile(name).decryptPeek(encBlob);   // 密文 peek → 明文；已明文(非 ENC_PEEK_MIME)原样返
}

/**
 * 确保 name 的密码在内存且验证过。**必须在 withBusy 之外调用**（要弹密码框）。
 * 内存密码先 verify（统一/per-name），不行就 prompt 循环（错→重问，取消→false）。
 * 验证经 store.verifyPassword（解 peek，便宜、不开 UI、不进 busy）。返回 false = 用户取消。
 */
export async function ensureUnlocked(name: string): Promise<boolean> {
  const cur = getPassword(name);
  if (cur && await encFile(name).verifyPassword(cur)) return true;
  for (let attempt = 0; ; attempt++) {
    const pw = await promptPassword({
      title: "解锁加密作品",
      message: attempt > 0 ? "密码不对，再试一次" : "输入图库密码。密码只存在内存里，关页即忘。",
    });
    if (pw == null) return false;
    if (await encFile(name).verifyPassword(pw)) { onPasswordVerified(name, pw); return true; }
  }
}

/**
 * 解锁一段**外来的加密容器字节**（导入的文件还没进 store，没 name 可查 peek，只能全量解）。
 * 返回 { pw, plain }：验过的密码 + **解出来的明文**；取消 → null。**busy 外调用。**
 *
 * ⚠ 一次尝试 = 一次解密（v415）。旧版是 verifyContainer(全量解一遍验) + 调用方再 unsealWith(全量解第二遍)，
 *   导入一个加密作品要把整幅画用 7z-wasm 解**两遍**（密码试错时更多）。现在合一，成功那次的明文直接给调用方。
 * 明文只在返回的 Blob 里（内存）；密码不污染全局，记忆由调用方按落库 name 决定。
 */
export async function unlockImportedContainer(blob: Blob): Promise<{ pw: string; plain: Blob } | null> {
  const cur = getPassword(null);
  if (cur) {
    const plain = await store.encryption.tryDecryptEncryptedBlob(blob, cur);
    if (plain) return { pw: cur, plain };
  }
  for (let attempt = 0; ; attempt++) {
    const pw = await promptPassword({
      title: "解锁导入的加密文件",
      message: attempt > 0 ? "密码不对，再试一次" : "这是加密文件。输入它的密码。",
    });
    if (pw == null) return null;
    const plain = await store.encryption.tryDecryptEncryptedBlob(blob, pw);
    if (plain) return { pw, plain };
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
