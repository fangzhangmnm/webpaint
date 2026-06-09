// 深模块策略：move-aside（删除 / 覆盖前留底）的**命名 + 隐藏命名空间**约定。规则只写在这里，
// 不散到 app。tier 无关——cloud 用 .trash/ /.backup/ 文件夹，local 用 .backup-local/ 键前缀；
// 命名与防撞这一份策略两边共用。
//
// 名字 = `<base> [<yyyymmddhhmmss>-<guid>]`：
//   - yyyymmddhhmmss：人读的秒级时间，一眼看出「哪个时间点的备份」；
//   - guid：防撞用真随机 GUID（不是秒级时间能保证的——同秒多次留底、跨 reload 都不撞；
//     与本仓「identity = GUID」一脉，见 MASTER.md）。
// 纯叶子模块（只依赖 Date/crypto），cloud-sync / local-adapter / session.js 都可安全 import（无环）。

export const LOCAL_BACKUP_PREFIX = ".backup-local/";   // 本地隐藏命名空间（镜像云端 .backup/）；不进图库、不 flood 用户文件夹

function pad(n: number, w = 2) { return String(n).padStart(w, "0"); }

function yyyymmddhhmmss(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function guid() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  // fallback：手搓 v4
  const a = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
  const h = Array.from(a, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10,16).join("")}`;
}

/** move-aside 防撞标：`<yyyymmddhhmmss>-<guid>`。ms 由调用方给（cloud-sync 注入时钟便于测试；local 用 Date.now）。 */
export function asideStamp(ms: number) { return `${yyyymmddhhmmss(ms)}-${guid()}`; }
