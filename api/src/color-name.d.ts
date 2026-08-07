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
/** 颜色名（任意词库 / 色温 / `category:名`）→ hex；认不出 → null。hex 归调用方先走 normalizeHex。 */
export declare function parseColorName(text: string): string | null;
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
