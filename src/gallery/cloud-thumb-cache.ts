// 云端 ora thumbnail 的 IDB 缓存（v137；store-cutover 2026-07-12 重锚；v401 专用 store + key 对齐 store 身份）
//
// 存法：weebpaint DB 的 **gallery-thumbs 专用 object store**（不挤 meta 大篮子），
//   key = store 文件身份 = sessionFileName(裸名) = 全名 X.ora（与 cloud-thumbs.ts 传给 store.file 的 key 逐字一致）。
//   value = { token, blob, at }。
//   - token = 新鲜度戳（cloud.lastModifiedDateTime 优先，退 size）。token 变 = 文件改了 → 重拉 + 覆盖同 key。
//   - token 同 = blob 仍有效，直接用。
//
// 无 itemId → 改名的作品换 name = 换 store-key = 换 cache key（旧条目成孤儿，随 clearCloudThumbCache 清）。
//   同名编辑走 token 比对、覆盖同 key，不累积孤儿。失效不需 TTL：下次 list 拿到新 lastModified/size 即重拉。
//
// 加密作品：fetchOraThumbnail 返回**密文** blob（type=ENC_PEEK_MIME），缓存原样存密文 → 明文缩略图不落 IDB；
//   caller（gallery）拿密文当「这是加密项」信号，经 store getPeek 按锁态解。
//
// 容量：256×256 PNG ~25KB/张；500 张 ≈ 12MB。本机 IDB 配额 GB 级，可忽略。
// 真要清：window.WeebPaint.clearCloudThumbCache()
//
// 不在这处理：网络拉取本身 / IntersectionObserver / 并发限流（caller 负责）

import { reportError } from "../error-badge.ts";
import { getThumb, setThumb, deleteThumb, clearThumbs } from "../storage.ts";
import { fetchOraThumbnail } from "./cloud-thumbs.ts";
import { sessionFileName } from "../config.ts";

// cache key = store 文件身份（sessionFileName(裸名)=全名 X.ora）；专用 store 即命名空间，key 无需前缀。caller 仍传裸名。
function _key(name: string): string { return sessionFileName(name); }

// IDB 里存的缓存条目形态
interface CachedThumb {
  token: string;
  blob: Blob;
  at: number;
}

// cache stats（console 用：WeebPaint.cloudThumbStats()）
export const stats: { hits: number; misses: number; errors: number } = { hits: 0, misses: 0, errors: 0 };
export function resetStats() { stats.hits = 0; stats.misses = 0; stats.errors = 0; }

// debug toggle：开了就不读 IDB cache，每次走网络 → 看 telemetry 路径分布
// 用法：WeebPaint.cloudThumbSkipCache(true)
export const config: { skipCache: boolean } = { skipCache: false };

/** 读 cache。返回 { token, blob, at } 或 null */
export async function readCachedThumb(name: string): Promise<CachedThumb | null> {
  try {
    const v = await getThumb(_key(name)) as CachedThumb | undefined;
    if (v && v.blob && v.token) return v;
    return null;
  } catch (_) { return null; }
}

/** 写 cache（fire-and-forget；失败不影响主流程） */
export async function writeCachedThumb(name: string, token: string, blob: Blob): Promise<void> {
  try {
    await setThumb(_key(name), { token, blob, at: Date.now() });
  } catch (e) {
    reportError(new Error("[cloud-thumb-cache] write failed: " + String(e)), "log");
  }
}

// 失效广播（v0.10.2）：删条目只解决「下次 miss」，救不了**在世的 tile**——gallery 的 ThumbCell 被
//   keyed v-for 复用、onMounted 一辈子只跑一次；且 token 的 lastModified 云端优先（listing seam），
//   本机保存后推送未落地期间 token 纹丝不动 → 单靠 token 比对听不到本地保存。所以 invalidate 同时
//   通知订阅者（gallery 用它 bump per-key rev → tile 原地重取；getPeek 本地优先=刚写的字节）。
type ThumbInvalidatedListener = (key: string) => void;   // key = _key(name) = 全名 X.ora
const _invalidated = new Set<ThumbInvalidatedListener>();
export function onThumbInvalidated(fn: ThumbInvalidatedListener): void { _invalidated.add(fn); }

/** 让一件作品的缩略图缓存立即作废（bytes 变了：保存/加密/解密/revert 后）。删同 key + 广播，在世 tile 重取。 */
export async function invalidateCachedThumb(name: string): Promise<void> {
  try { await deleteThumb(_key(name)); } catch (_) { /* best-effort */ }
  for (const fn of _invalidated) { try { fn(_key(name)); } catch (_) { /* listener 自理 */ } }
}

/**
 * 拿 thumbnail。优先 cache（token 匹配）；miss 走网络（peekTail）+ 回写 cache。
 * 失败抛错（caller 显示 placeholder）。
 *
 * @param {string} name       库的裸 session 名（item.name，无后缀 = store.file 的 key）
 * @param {string} token      新鲜度戳（cloud.lastModifiedDateTime 优先，退 size）；变 = 重拉
 * @returns {Promise<{ blob: Blob, fromCache: boolean }>}
 */
export async function getOrFetchCloudThumb(name: string, token: string): Promise<{ blob: Blob; fromCache: boolean }> {
  if (!config.skipCache) {
    const cached = await readCachedThumb(name);
    if (cached && cached.token === token) {
      stats.hits++;
      return { blob: cached.blob, fromCache: true };
    }
  }
  stats.misses++;
  try {
    const blob = await fetchOraThumbnail(name);
    if (!config.skipCache) writeCachedThumb(name, token, blob);
    return { blob, fromCache: false };
  } catch (e) {
    stats.errors++;
    throw e;
  }
}

/** 调试：清空全部缩略图 cache（清空 gallery-thumbs store，返删除数） */
export async function clearCloudThumbCache(): Promise<number> {
  const n = await clearThumbs();
  resetStats();
  return n;
}
