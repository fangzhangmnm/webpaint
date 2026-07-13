// 云端/本地 ora 缩略图取字节 —— **薄封装**（zip 解析在库 store/zip-peek.ts；v399 起格式盲、按文件名取）。
//
// 这里只剩 app 域知识：WebPaint 的缩略图 = ora 内 `Thumbnails/thumbnail.png`、先拉尾窗口 80KB。
//   库的 ZipFile.getPeek({bytesLength, zipEntry}) 负责：本地切片∨云端 byte-range 取尾片 → 解 EOCD/CD →
//   **按文件名**抓 entry（CD/entry 溢出尾片则各一次额外 byte-range）。明文 ora → entry 原始字节 blob(无 type)；
//   加密 ora → 密文 peek blob(ENC_PEEK_MIME，caller 缓存原样存密文)。库不认 PNG/任何内容格式。
//   身份 = 库的**裸 session 名**（item.name），边界 sessionFileName 转全名（库身份=X.ora）。
import { store } from "./app-store.ts";
import { sessionFileName } from "./config.ts";

// 先拉尾窗口 80KB：thumb 自适应目标 ≤70KB + 尾巴 ~10KB（CD + EOCD）。图层多 → CD 大把缩略图挤出尾片，
//   库会用额外 byte-range 拉 CD、再拉缩略图 entry（不再退占位）。
export const SUFFIX_BYTES = 81920;
export const THUMB_PATH = "Thumbnails/thumbnail.png";

/**
 * 拉一个 ora 的 thumbnail 字节：明文 → entry 原始字节 Blob（无 type）；加密 → 密文 peek Blob(type=ENC_PEEK_MIME)。
 * 不带 cache / retry / 限流（caller 负责）。取不到 → 抛（caller 显占位图）。
 * @param name 库的裸 session 名（item.name，无 .ora/.zip 后缀）
 */
export async function fetchOraThumbnail(name: string): Promise<Blob> {
  const blob = await store.file(sessionFileName(name), { isZip: true }).getPeek({ bytesLength: SUFFIX_BYTES, zipEntry: THUMB_PATH });
  if (!blob) throw new Error("getPeek 返回 null（云端不可达 / 无此文件 / 无此 entry / 无本地副本）");
  return blob;
}
