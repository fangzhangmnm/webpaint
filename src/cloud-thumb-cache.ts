// 云端 ora thumbnail 的 IDB 缓存（v137）
//
// key 形态：`cloud-thumb:<itemId>` 存 meta store，value = { etag, blob, at }
//   - itemId 跨 rename 稳定（OneDrive 保证）→ 文件改名不失效
//   - etag 变 = 文件改了 → 重拉 + 覆盖
//   - etag 同 = blob 仍然有效，直接用
//
// 失效路径：用户在 OneDrive 网页改文件 / 桌面 OneDrive 同步覆盖 → 下次 list
// 会拿到新 etag，我们对比就重拉。不需要 TTL。
//
// 容量：256×256 PNG ~25KB/张；500 张 ≈ 12MB。本机 IDB 配额 GB 级，可忽略。
// 真要清：window.WebPaint.clearCloudThumbCache()
//
// 不在这处理：网络拉取本身 / IntersectionObserver / 并发限流（caller 负责）

import { getMeta, setMeta } from "./storage.ts";
import { fetchOraThumbnail } from "./cloud-thumbs.ts";
import { getDownloadUrl } from "./app-store.js";

const KEY_PREFIX = "cloud-thumb:";

function _key(itemId: string): string { return KEY_PREFIX + itemId; }

// IDB 里存的缓存条目形态
interface CachedThumb {
  etag: string;
  blob: Blob;
  at: number;
}

// cache stats（console 用：WebPaint.cloudThumbStats()）
export const stats: { hits: number; misses: number; errors: number } = { hits: 0, misses: 0, errors: 0 };
export function resetStats() { stats.hits = 0; stats.misses = 0; stats.errors = 0; }

// debug toggle：开了就不读 IDB cache，每次走网络 → 看 telemetry 路径分布
// 用法：WebPaint.cloudThumbSkipCache(true)
export const config: { skipCache: boolean } = { skipCache: false };

/** 读 cache。返回 { etag, blob, at } 或 null */
export async function readCachedThumb(itemId: string): Promise<CachedThumb | null> {
  try {
    const v = await getMeta(_key(itemId)) as CachedThumb | undefined;
    if (v && v.blob && v.etag) return v;
    return null;
  } catch (_) { return null; }
}

/** 写 cache（fire-and-forget；失败不影响主流程） */
export async function writeCachedThumb(itemId: string, etag: string, blob: Blob): Promise<void> {
  try {
    await setMeta(_key(itemId), { etag, blob, at: Date.now() });
  } catch (e) {
    console.warn("[cloud-thumb-cache] write failed:", e);
  }
}

/**
 * 拿 thumbnail。优先 cache（etag 匹配）；miss 走网络 + 回写 cache。
 * 失败抛错（caller 显示 placeholder）。
 *
 * @param {string} itemId
 * @param {string} etag       来自 listChildren item.eTag
 * @param {number} fileSize
 * @returns {Promise<Blob>}
 */
/**
 * @param {string} itemId
 * @param {string} etag       listChildren item.eTag
 * @param {number} fileSize
 * @param {string|null} [downloadUrl] — listChildren 带回的 1h 短效 CDN URL
 *   有 → 省每张 thumb 的 metadata RTT；401/403 过期会重申请一次再试
 * @returns {Promise<{ blob: Blob, fromCache: boolean }>}
 */
export async function getOrFetchCloudThumb(itemId: string, etag: string, fileSize: number, downloadUrl: string | null = null): Promise<{ blob: Blob; fromCache: boolean }> {
  if (!config.skipCache) {
    const cached = await readCachedThumb(itemId);
    if (cached && cached.etag === etag) {
      stats.hits++;
      return { blob: cached.blob, fromCache: true };
    }
  }
  stats.misses++;
  try {
    const blob = await _fetchWithExpireRetry(itemId, fileSize, downloadUrl);
    if (!config.skipCache) writeCachedThumb(itemId, etag, blob);
    return { blob, fromCache: false };
  } catch (e) {
    stats.errors++;
    throw e;
  }
}

// 带 downloadUrl 时优先直打 CDN；过期（401/403）→ 重新申请 1 次 → 仍失败抛
async function _fetchWithExpireRetry(itemId: string, fileSize: number, downloadUrl: string | null): Promise<Blob> {
  if (!downloadUrl) return await fetchOraThumbnail(itemId, fileSize);
  try {
    return await fetchOraThumbnail(itemId, fileSize, { downloadUrl });
  } catch (e) {
    if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) {
      const fresh = await getDownloadUrl(itemId);
      if (!fresh) throw e;
      return await fetchOraThumbnail(itemId, fileSize, { downloadUrl: fresh });
    }
    throw e;
  }
}

/** 调试：清空全部缩略图 cache（扫 meta store，删 cloud-thumb:* keys，返删除数） */
export async function clearCloudThumbCache(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = indexedDB.open("webpaint");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const cur = store.openCursor();
      let n = 0;
      cur.onsuccess = (ev: Event) => {
        const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) {
          tx.oncomplete = () => { resetStats(); resolve(n); };
          return;
        }
        if (String(cursor.key).startsWith(KEY_PREFIX)) {
          cursor.delete();
          n++;
        }
        cursor.continue();
      };
      cur.onerror = () => reject(cur.error);
    };
    req.onerror = () => reject(req.error);
  });
}
