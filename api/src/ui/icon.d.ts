export type IconName = string;
/** 图标的 HTML 字符串（给 innerHTML / v-html / 模板拼接用）。 */
export declare function iconHtml(name: IconName, opts?: {
    size?: number;
    cls?: string;
}): string;
/** 图标 DOM 节点（给 appendChild 用）。 */
