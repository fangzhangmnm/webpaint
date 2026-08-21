export interface ColorCategory {
    id: string;
    label: string;
    aliases: string[];
    naming: boolean;
    default_for: string[];
    parent?: string | null;
    multi_anchor?: boolean;
    suppress?: boolean;
    kind?: string;
}
type WordRow = [string, string, string, string?, number?];
export declare function _adoptColorWords(data: {
    categories: ColorCategory[];
    words: WordRow[];
}): void;
export declare function kelvinToHex(kelvin: number): string;
export declare function defaultCulture(): string;
/** 可参与命名的词库（explode sheet 下拉的数据源；label = culture 自己语言的显示名）。 */
export declare function namingCategories(): {
    id: string;
    label: string;
}[];
export declare function categoryLabel(id: string): string;
/** 指定 culture 下这个颜色叫什么。词库没到 → 返回 hex（诚实降级，不瞎编）。 */
export declare function colorNameIn(l: string, r: number, g: number, b: number): string;
/** 默认 culture（按 localization 映射）下这个颜色叫什么（死字符串，烘焙即定）。 */
export declare function colorNameOf(r: number, g: number, b: number): string;
/** 颜色名（任意词库 / 色温 / `category:名`）→ hex；认不出 → null。
 *  hex 归调用方（UI 输入框统一走下面的 parseColorInput：带 `#` 恒 hex、裸串色名优先）。 */
export declare function parseColorName(text: string): string | null;
/** UI 色输入框统一解析（色轮 hex 框 / 导出底色框共用，2026-08-21）：
 *  · 显式带 `#` → 恒 hex（normalizeHex；非法就 null，色名不掺和）；
 *  · 裸串 → **先色名**、色名不中再补 `#` 试 hex。
 *  为什么色名优先：词库（家族色彩库）会持续膨胀，哪天进一个六位纯 hex 字母的词
 *  （facade/decade 类），旧的「hex 优先」会把它静默当色码吞掉；想要 hex 的用户写 `#` 即恒赢。 */
export declare function parseColorInput(text: string): string | null;
/** 候选：色词（name+hex）或词库本身（category——IntelliSense 是 discovery，部分输入 category
 *  名即出「中国传统色:」候选，选中回填前缀继续浏览整板）。 */
export interface ColorNameHit {
    name: string;
    hex: string;
    category?: string;
}
/** `category:` 前缀 = 浏览整个色板（**保持源序**——retro palette 的编号序就是身份；rest 再按
 *  三档模糊过滤）。色温出单条候选。普通查询 = category 候选置顶（discovery）→ 前缀 → 子串 →
 *  子序列（有限 limit 时子串+子序列合计保底一半槽位——中文品类字在尾巴，输「黄」必须查得到
 *  「豆汁黄」）。名与别名（かな/拼音）都参与匹配，显示用正名。 */
export declare function searchColorNames(query: string, limit?: number): ColorNameHit[];
export {};
