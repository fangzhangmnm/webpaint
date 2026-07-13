// 云端 ora thumbnail 的 IDB 缓存（v137；store-cutover 2026-07-12 重锚）
//
// key 形态：`cloud-thumb:<name>` 存 meta store，value = { token, blob, at }
//   - name = 库的裸 session 名（item.name，无后缀）—— 薄库不再暴露 OneDrive itemId（内容盲，身份=path）。
//   - token = 新鲜度戳（cloud.lastModifiedDateTime 优先，退 size）。token 变 = 文件改了 → 重拉 + 覆盖同 key。
//   - token 同 = blob 仍有效，直接用。
//
// 与旧 itemId key 的取舍：无 itemId → 改名的作品换 name = 换 key（旧条目成孤儿，随 clearCloudThumbCache 清）。
//   同名编辑走 token 比对、覆盖同 key，不累积孤儿。失效不需 TTL：下次 list 拿到新 lastModified/size 即重拉。
//
// 加密作品：fetchOraThumbnail 返回**密文** blob（type=ENC_PEEK_MIME），缓存原样存密文 → 明文缩略图不落 IDB；
//   caller（gallery）拿密文当「这是加密项」信号，经 store getPeek 按锁态解。
//
// 容量：256×256 PNG ~25KB/张；500 张 ≈ 12MB。本机 IDB 配额 GB 级，可忽略。
// 真要清：window.WebPaint.clearCloudThumbCache()
//
// 不在这处理：网络拉取本身 / IntersectionObserver / 并发限流（caller 负责）

import { getMeta, setMeta } from "./storage.ts";
import { fetchOraThumbnail } from "./cloud-thumbs.ts";

const KEY_PREFIX = "cloud-thumb:";

function _key(name: string): string { return KEY_PREFIX + name; }

// IDB 里存的缓存条目形态
interface CachedThumb {
  token: string;
  blob: Blob;
  at: number;
}

// cache stats（console 用：WebPaint.cloudThumbStats()）
export const stats: { hits: number; misses: number; errors: number } = { hits: 0, misses: 0, errors: 0 };
export function resetStats() { stats.hits = 0; stats.misses = 0; stats.errors = 0; }

// debug toggle：开了就不读 IDB cache，每次走网络 → 看 telemetry 路径分布
// 用法：WebPaint.cloudThumbSkipCache(true)
export const config: { skipCache: boolean } = { skipCache: false };

/** 读 cache。返回 { token, blob, at } 或 null */
export async function readCachedThumb(name: string): Promise<CachedThumb | null> {
  try {
    const v = await getMeta(_key(name)) as CachedThumb | undefined;
    if (v && v.blob && v.token) return v;
    return null;
  } catch (_) { return null; }
}

/** 写 cache（fire-and-forget；失败不影响主流程） */
export async function writeCachedThumb(name: string, token: string, blob: Blob): Promise<void> {
  try {
    await setMeta(_key(name), { token, blob, at: Date.now() });
  } catch (e) {
    console.warn("[cloud-thumb-cache] write failed:", e);
  }
}

/**
 * 拿 thumbnail。优先 cache（token 匹配）；miss 走网络（peekTail）+ 回写 cache。
 * 失败抛错（caller 显示 placeholder）。
 *
 * @param {string} name       库的裸 session 名（item.name，无后缀 = store.file 的 key）
 * @param {string} token      新鲜度戳（cloud.lastModifiedDateTime 优先，退 size）；变 = 重拉
 * @param {number} fileSize   文件总字节（cloud.size）——供 ZIP fallback 判偏移；缺省 0 = 未知
 * @returns {Promise<{ blob: Blob, fromCache: boolean }>}
 */
export async function getOrFetchCloudThumb(name: string, token: string, fileSize = 0): Promise<{ blob: Blob; fromCache: boolean }> {
  if (!config.skipCache) {
    const cached = await readCachedThumb(name);
    if (cached && cached.token === token) {
      stats.hits++;
      return { blob: cached.blob, fromCache: true };
    }
  }
  stats.misses++;
  try {
    void fileSize;   // 遗留参数：尾窗口偏移判定已下沉进库 getPeek（库自算 size）；签名保留不破坏 gallery 调用
    const blob = await fetchOraThumbnail(name);
    if (!config.skipCache) writeCachedThumb(name, token, blob);
    return { blob, fromCache: false };
  } catch (e) {
    stats.errors++;
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
