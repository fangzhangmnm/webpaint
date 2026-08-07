export interface CanvasTemplate {
    id: string;
    label: string;
    i18n?: string;
    kind: "print" | "screen" | "pixel";
    w: number;
    h: number;
    unit: "px" | "mm" | "in";
    dpi?: number;
}
/** 测试注入点（node 环境没有可 fetch 的 json asset）。 */
export declare function _adoptCanvasTemplates(list: CanvasTemplate[]): void;
/** 加载 json（幂等；失败只 log——SW 已 precache，首访失败下次调用会重试）。 */
export declare function loadCanvasTemplates(): Promise<void>;
export declare function allTemplates(): CanvasTemplate[];
export declare function templateById(id: string): CanvasTemplate | null;
/** 模板 → 目标像素尺寸（print 类按 DPI 换算，round 到整像素）。 */
export declare function templatePx(tp: CanvasTemplate): {
    w: number;
    h: number;
};
/** 显示文本：i18n（有则用）+ 物理单位模板自动追加换算出的像素数（label 里手写会漂移）。 */
export declare function templateLabel(tp: CanvasTemplate): string;
/**
 * 把模板表投影进一个 <select>：按 kind 分 optgroup，末尾追加「自定义…」。
 * 两个消费面（新建作品 / 裁剪模板模式）共用这一份渲染，**显示完全一样的列表**
 * （v0.7.34 user 定；此前有个 surfaces 分面白名单，已连同机制一起删掉）。
 * json 是 async fetch 的 → 调用方在 loadCanvasTemplates() resolve 后调；重复调用幂等（先清空再填）。
 */
export declare function fillTemplateSelect(sel: HTMLSelectElement, customLabel: string): void;
