// 职责（单一）：颜色 ↔ 名字。纯函数 + 一个独立 asset 加载器，零 canvas。
//
// 数据 = **color-words.json**（根目录独立 asset，runtime fetch——builtin-brushes.json 同款先例：
//   SW precache 离线兜底、失败可重试不终身；不进 JS bundle，因为词库会持续膨胀）。
//   SSoT 在家族色彩库 `20260730 Colors`（一个兔子洞一个贡献包 → build.py 编译）；
//   宿主**零改码**扩词库：category 元数据（label/aliases/naming/default_for/parent 两级树）
//   全部随数据来，dropdown / `category:` 前缀 / 默认词库映射都是数据驱动。
//
// · colorNameIn(cat, r,g,b)：命名 = 按 culture（≠localization，user 2026-07-30 拍板）过滤词表
//   （slang 行跳过；该 culture 无行 → xkcd 兜底；数据没到 → 返回 hex 字符串，诚实不瞎编）。
//   nearest 在 OKLab（感知均匀，RGB 欧氏会把蓝紫认错）。产出 = **死字符串**（烘焙即定不回译）。
// · parseColorName(text)：① 色温 `5600k` → Planck 黑体色（纯数学，不吃词库）；
//   ② `category:名`（id / 别名 / label 都认，父类 = 子类并集）；③ 全词库字典
//   （大小写/空格不敏感 + 去空格/冒号变体，slang 照认——输入不 censor）。
// · searchColorNames(query)：IntelliSense 数据面。`category:` 前缀 = 浏览整个色板
//   （**保持源序**——retro palette 的编号序就是身份）；色温出单条候选；普通查询 =
//   前缀命中优先、子串命中殿后（有限 limit 时子串保底一半槽位）。

import { lang } from "./i18n/index.ts";
import { reportError } from "./error-badge.ts";
import { srgbToOklab } from "./common/color-dist.ts";

// ---- 数据装载（brushes.ts 同款：成功恒定缓存；失败不留缓存 → 下次调用自动重试）----
export interface ColorCategory {
  id: string; label: string; aliases: string[]; naming: boolean;
  default_for: string[]; parent?: string | null; multi_anchor?: boolean;
  suppress?: boolean; kind?: string;
}
// [cat, name, hex, alias?, flags?]。flags 位域：1=slang（parse 照认/命名跳过）、
// 2=suppress（被动检索面隐身：全局裸名 parse/联想/命名不出；`板:` 作用域寻址照常；
// 全局命中同板非 suppress 词时板友追加候选尾——兄弟联想）。schema v2（2026-07-30 B 案）。
type WordRow = [string, string, string, string?, number?];
const F_SUPPRESS = 2;

let _cats: ColorCategory[] = [];
let _rows: WordRow[] = [];
let _inflight: Promise<void> | null = null;

// 测试 / 数据热替换入口：直接喂 colors.json 的解析结果（node 测试没有可 fetch 的相对路径）。
export function _adoptColorWords(data: { categories: ColorCategory[]; words: WordRow[] }): void {
  _cats = data.categories;
  _rows = data.words;
  _naming.clear();
  _parseIdx = null;
}

async function _load(): Promise<void> {
  if (_rows.length) return;
  if (!_inflight) {
    _inflight = (async () => {
      try {
        const url = new URL("./color-words.json", document.baseURI).href;
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (!Array.isArray(j?.categories) || !Array.isArray(j?.words)) throw new Error("color-words.json 格式不对");
        _adoptColorWords(j);
      } catch (e) {
        reportError(new Error("[color-name] color-words.json 加载失败 → 本次无色名词库（下次调用重试）。" + String(e)), "log");
      }
    })().finally(() => { _inflight = null; });
  }
  return _inflight;
}
// 浏览器模块加载即预热（「什么时候拿到什么时候填」）；node 纯测试环境跳过。
if (typeof document !== "undefined" && typeof fetch === "function") void _load();

// ---- OKLab：v0.7.21 收拢进 color-dist.ts（魔棒判据共用一份，LUT 版对 8-bit 输入精确等价）----

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function rgbHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

// ---- 色温 → 颜色（user 2026-07-30：「逃不掉」）----
// CCT → Planck 轨迹 xy（Kim et al 三次多项式近似，1667–25000K，入参夹取）→ XYZ →
// 线性 sRGB → 负值截断 → 按最大通道归一（黑体亮度无界，取「这个色温的白」）→ gamma。
// 纯数学零词库；painters 的冷暖光语言：1900 烛光 / 3200 钨丝 / 5600 日光 / 6500 D65。
export function kelvinToHex(kelvin: number): string {
  const T = Math.max(1667, Math.min(25000, kelvin));
  const T2 = T * T, T3 = T2 * T;
  const x = T <= 4000
    ? -0.2661239e9 / T3 - 0.2343589e6 / T2 + 0.8776956e3 / T + 0.179910
    : -3.0258469e9 / T3 + 2.1070379e6 / T2 + 0.2226347e3 / T + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222
    ? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const peak = Math.max(r, g, b) || 1;
  const gam = (c: number) => { c /= peak; return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
  return rgbHex(gam(r), gam(g), gam(b));
}
const KELVIN_RE = /^(\d{3,5}(?:\.\d+)?)\s*k$/;

// ---- category 元数据查询（全数据驱动）----
function norm(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, " "); }

// localization → 默认 culture 的唯一映射点（数据里的 default_for；没到/没中 → xkcd 兜底）。
export function defaultCulture(): string {
  const l = lang();
  return _cats.find((c) => c.default_for.includes(l))?.id ?? "xkcd";
}

/** 可参与命名的词库（explode sheet 下拉的数据源；label = culture 自己语言的显示名）。 */
export function namingCategories(): { id: string; label: string }[] {
  return _cats.filter((c) => c.naming).map((c) => ({ id: c.id, label: c.label }));
}
export function categoryLabel(id: string): string {
  return _cats.find((c) => c.id === id)?.label ?? id;
}

// schema v2：任意深度树（≤3 级）——「任何节点 = 它的子树」。
function subtreeIds(rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const c of _cats) if (c.parent === out[i]) out.push(c.id);
  }
  return out;
}
// 被动隐身判定：自身或任一祖先 suppress（作用域寻址不走这条——显式 token 永远可达）。
function catPassiveHidden(id: string): boolean {
  const seen = new Set<string>();
  let cur = _cats.find((c) => c.id === id);
  while (cur && !seen.has(cur.id)) {
    if (cur.suppress) return true;
    seen.add(cur.id);
    cur = cur.parent ? _cats.find((c) => c.id === cur!.parent) : undefined;
  }
  return false;
}

// `category:` 前缀 token → 子树 id 集（id / 别名 / label 都认；混合节点自身的词也在内）。
function resolveCategoryToken(token: string): string[] | null {
  const t = norm(token);
  if (!t) return null;
  const hit = _cats.find((c) => norm(c.id) === t || norm(c.label) === t || c.aliases.some((a) => norm(a) === t));
  return hit ? subtreeIds(hit.id) : null;
}

// ---- 命名 ----
interface NamingTable { labels: string[]; labs: Float64Array }
const _naming = new Map<string, NamingTable>();
function namingTable(l: string): NamingTable | null {
  if (!_rows.length) return null;
  let t = _naming.get(l);
  if (!t) {
    // 子树命名 + flags（slang/suppress）与被动隐身类的词都不参与（命名要出的是能见人的名）
    const ids = new Set(subtreeIds(l).filter((id) => !catPassiveHidden(id)));
    let rows = _rows.filter((r) => ids.has(r[0]) && !r[4]);
    if (rows.length === 0) rows = _rows.filter((r) => r[0] === "xkcd" && !r[4]);   // 未收录 culture 兜底
    if (rows.length === 0) return null;
    const labels = rows.map((r) => r[1]);
    const labs = new Float64Array(rows.length * 3);
    for (let i = 0; i < rows.length; i++) {
      const [r, g, b] = hexRgb(rows[i][2]);
      const [L, a, bb] = srgbToOklab(r, g, b);
      labs[i * 3] = L; labs[i * 3 + 1] = a; labs[i * 3 + 2] = bb;
    }
    t = { labels, labs };
    _naming.set(l, t);
  }
  return t;
}

/** 指定 culture 下这个颜色叫什么。词库没到 → 返回 hex（诚实降级，不瞎编）。 */
export function colorNameIn(l: string, r: number, g: number, b: number): string {
  const table = namingTable(l);
  if (!table) { void tryPreload(); return rgbHex(r, g, b); }
  const { labels, labs } = table;
  const [L, a, bb] = srgbToOklab(r, g, b);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < labels.length; i++) {
    const dL = L - labs[i * 3], da = a - labs[i * 3 + 1], db = bb - labs[i * 3 + 2];
    const d = dL * dL + da * da + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return labels[bi];
}

/** 默认 culture（按 localization 映射）下这个颜色叫什么（死字符串，烘焙即定）。 */
export function colorNameOf(r: number, g: number, b: number): string {
  return colorNameIn(defaultCulture(), r, g, b);
}

// 消费时数据还没到 → 补一脚加载（浏览器限定；node 测试环境静默跳过）。
function tryPreload(): void {
  if (typeof document !== "undefined" && typeof fetch === "function") void _load();
}

// ---- parse ----
let _parseIdx: Map<string, string> | null = null;
function parseIdx(): Map<string, string> {
  if (!_parseIdx) {
    const idx = _parseIdx = new Map<string, string>();
    const put = (label: string, hex: string) => {
      const k = norm(label);
      if (!idx.has(k)) idx.set(k, hex);
      const nospace = k.replace(/[ :]/g, "");   // skyblue / tabblue / tab:blue→tabblue
      if (!idx.has(nospace)) idx.set(nospace, hex);
    };
    for (const [cat, name, hex, alias, flags] of _rows) {   // 表行序 = 优先级，先到先得
      if (((flags ?? 0) & F_SUPPRESS) || catPassiveHidden(cat)) continue;   // 被动面隐身
      put(name, hex);
      if (name.includes(":")) put(name.replace(":", " "), hex);   // "tab blue"（带空格变体）
      if (alias) put(alias, hex);                                  // かな读音 / 拼音
    }
  }
  return _parseIdx;
}

/** 颜色名（任意词库 / 色温 / `category:名`）→ hex；认不出 → null。hex 归调用方先走 normalizeHex。 */
export function parseColorName(text: string): string | null {
  const q = norm(text);
  if (!q) return null;
  const mk = q.match(KELVIN_RE);
  if (mk) return kelvinToHex(parseFloat(mk[1]));
  if (!_rows.length) { tryPreload(); return null; }
  const mc = q.match(/^([^:：]+)[:：]\s*(.*)$/);
  if (mc) {
    const cats = resolveCategoryToken(mc[1]);
    if (cats) {   // `category:名` —— 在该色板内找（名或别名精确匹配）
      const rest = norm(mc[2]);
      if (!rest) return null;
      for (const [cat, name, hex, alias] of _rows) {
        if (!cats.includes(cat)) continue;
        if (norm(name) === rest || (alias && norm(alias) === rest)) return hex;
      }
      return null;
    }
    // token 不是 category（例：tab:blue 的 "tab"）→ 落回全字典
  }
  return parseIdx().get(q) ?? null;
}

// ---- IntelliSense 数据面 ----
// 模糊三档（user 2026-07-30：「匹配尽量模糊」）：0=前缀 / 1=子串 / 2=子序列（「豆黄」→「豆汁黄」、
// "tblue"→"tab:blue"）。命中不到 → -1。
function matchTier(cand: string, q: string): number {
  if (!cand) return -1;
  if (cand.startsWith(q)) return 0;
  if (cand.includes(q)) return 1;
  let i = 0;
  for (let j = 0; j < cand.length && i < q.length; j++) if (cand[j] === q[i]) i++;
  return i === q.length ? 2 : -1;
}
function bestTier(q: string, ...cands: (string | undefined)[]): number {
  let best = -1;
  for (const c of cands) {
    if (!c) continue;
    const t = matchTier(c, q);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** 候选：色词（name+hex）或词库本身（category——IntelliSense 是 discovery，部分输入 category
 *  名即出「中国传统色:」候选，选中回填前缀继续浏览整板）。 */
export interface ColorNameHit { name: string; hex: string; category?: string }

/** `category:` 前缀 = 浏览整个色板（**保持源序**——retro palette 的编号序就是身份；rest 再按
 *  三档模糊过滤）。色温出单条候选。普通查询 = category 候选置顶（discovery）→ 前缀 → 子串 →
 *  子序列（有限 limit 时子串+子序列合计保底一半槽位——中文品类字在尾巴，输「黄」必须查得到
 *  「豆汁黄」）。名与别名（かな/拼音）都参与匹配，显示用正名。 */
export function searchColorNames(query: string, limit = Infinity): ColorNameHit[] {
  const q = norm(query);
  if (!q) return [];
  const mk = q.match(KELVIN_RE);
  if (mk) return [{ name: `${mk[1]}K`, hex: kelvinToHex(parseFloat(mk[1])) }];
  if (!_rows.length) { tryPreload(); return []; }
  const mc = q.match(/^([^:：]+)[:：]\s*(.*)$/);
  if (mc) {
    const cats = resolveCategoryToken(mc[1]);
    if (cats) {
      const rest = norm(mc[2]);
      const tiers: ColorNameHit[][] = [[], [], []];
      for (const [cat, name, hex, alias] of _rows) {
        if (!cats.includes(cat)) continue;
        if (!rest) { tiers[0].push({ name, hex }); continue; }   // 裸 `category:` = 整板（源序）
        const t = bestTier(rest, norm(name), alias ? norm(alias) : undefined);
        if (t >= 0) tiers[t].push({ name, hex });
      }
      const all = tiers[0].concat(tiers[1], tiers[2]);
      return Number.isFinite(limit) ? all.slice(0, limit) : all;
    }
  }
  // category discovery：查询模糊命中词库 id/label/别名 → 「label:」候选置顶（选中回填前缀）。
  // 所有词库都可浏览（browsing ≠ naming——css/mpl 也在此可发现）；suppress 的被动隐身。
  const catHits: ColorNameHit[] = [];
  for (const c of _cats) {
    if (catPassiveHidden(c.id)) continue;
    if (bestTier(q, norm(c.id), norm(c.label), ...c.aliases.map(norm)) >= 0) {
      catHits.push({ name: `${c.label}:`, hex: "", category: c.id });
    }
  }
  const qn = q.replace(/[ :]/g, "");
  const tiers: ColorNameHit[][] = [[], [], []];
  const seen = new Set<string>();
  const anchorCats = new Set<string>();   // 命中词所在板 → 板内 suppress 词的兄弟联想锚
  for (const [cat, name, hex, alias, flags] of _rows) {
    if (((flags ?? 0) & F_SUPPRESS) || catPassiveHidden(cat)) continue;   // 被动面隐身
    const n = norm(name);
    const key = n + hex;
    if (seen.has(key)) continue;
    const nn = n.replace(/[ :]/g, "");
    // 名 / 去空格名 / 别名 各算一遍取最优；查询自身的去空格形（"sky blue"→"skyblue"）也试。
    let t = bestTier(q, n, nn !== n ? nn : undefined, alias ? norm(alias) : undefined);
    if (qn !== q) {
      const t2 = matchTier(nn, qn);
      if (t2 >= 0 && (t < 0 || t2 < t)) t = t2;
    }
    if (t >= 0) { seen.add(key); tiers[t].push({ name, hex }); anchorCats.add(cat); }
  }
  // 兄弟联想：全局命中了某板的非 suppress 词 → 该板 suppress 的板友追加在候选尾
  const buddies: ColorNameHit[] = [];
  for (const [cat, name, hex, , flags] of _rows) {
    if (((flags ?? 0) & F_SUPPRESS) && anchorCats.has(cat) && !catPassiveHidden(cat)) buddies.push({ name, hex });
  }
  const [pre, sub, fuz] = tiers;
  if (!Number.isFinite(limit)) return catHits.concat(pre, sub, fuz, buddies);   // 无上限（默认）：档序即排序
  // 有限 limit 的槽位分配：category 候选不占配额算——先扣；子串+子序列合计保底 ⌈limit/2⌉；
  // 兄弟联想只补剩余空位。
  const rest = Math.max(0, limit - catHits.length);
  const tail = sub.concat(fuz);
  const tailQuota = Math.min(tail.length, Math.ceil(rest / 2));
  const preTake = Math.min(pre.length, rest - tailQuota);
  const main = catHits.concat(pre.slice(0, preTake), tail.slice(0, rest - preTake));
  return main.concat(buddies.slice(0, Math.max(0, limit - main.length)));
}
