// 云端/本地 ora 缩略图取字节 —— **薄封装**（2026-07-13 getPeek slice：zip 解析已下沉进库 store/zip-peek.ts）。
//
// 这里只剩 app 域知识：WebPaint 的缩略图 = ora 内 `Thumbnails/thumbnail.png`、尾窗口 128KB（thumb ≤70KB + zip 尾巴）。
//   库的 ZipFile.getPeek({bytesLength, zipEntry}) 负责：本地切片∨云端 byte-range 取尾片 → 硬扫末尾 PNG → 加密 MAGIC 扫
//   → 尾内 CD fallback。明文 ora → PNG blob(image/png)；加密 ora → 密文 peek blob(ENC_PEEK_MIME，caller 缓存原样存密文)。
//   身份 = 库的**裸 session 名**（item.name），边界 sessionFileName 转全名（库身份=X.ora）。
import { store } from "./app-store.ts";
import { sessionFileName } from "./config.ts";

// 投机尾窗口 128KB：thumb 自适应目标 ≤70KB + 尾巴 ~10KB（CD + EOCD + sig 扫描余量）。图层多的 ora 中央目录大、
//   把缩略图 entry 挤出小尾片 → 退占位（库不做任意偏移二次拉，避免给 store 加 peekRange 原语）。
export const SUFFIX_BYTES = 131072;
export const THUMB_PATH = "Thumbnails/thumbnail.png";

/**
 * 拉一个 ora 的 thumbnail 字节：PNG Blob（明文）或密文 peek Blob（加密，type=ENC_PEEK_MIME）。
 * 不带 cache / retry / 限流（caller 负责）。取不到 → 抛（caller 显占位图）。
 * @param name 库的裸 session 名（item.name，无 .ora/.zip 后缀）
 */
export async function fetchOraThumbnail(name: string): Promise<Blob> {
  const blob = await store.file(sessionFileName(name), { isZip: true }).getPeek({ bytesLength: SUFFIX_BYTES, zipEntry: THUMB_PATH });
  if (!blob) throw new Error("getPeek 返回 null（云端不可达 / 无此文件 / 缩略图不在尾片 / 无本地副本）");
  return blob;
}
