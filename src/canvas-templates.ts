// 画布模板：**数据在 canvas-templates.json**（根目录 asset，runtime fetch——builtin-brushes.json /
// color-words.json 同款先例）。本模块 = 加载 + 换算 + 往 <select> 里投影，不再自带表。
//
// 为什么外置（v0.7.32，user 2026-07-31 抓到）：此前模板存在**两份**——本文件的 TS 常量（裁剪·模板
// 模式读）和 index.html 里手写的 <option> 列表（新建作品读）。两份各自演化，往新建里加的尺寸裁切
// 永远看不到。现在两个面都投影自同一份 json，加模板零改码。
//
// DPI 本体论（user 拍板）：像素是画作唯一真相，DPI 只是输出解释——DPI 活在**模板**与导出
// 文件的 pHYs 里，永不写进 ora（防不懂的用户改乱 xres/yres 调不回）。
//
// 设计定稿：docs/20260729-crop-template-mode.md（裁剪模板模式）。

import { t, type Key } from "./i18n/index.ts";
import { reportError } from "./error-badge.ts";

export interface CanvasTemplate {
  id: string;                          // 稳定标识（editorState.crop.templateId 持久化了它——改名=破坏性）
  label: string;                       // 中文 UI 直读（i18n 缺席时的显示文本 / 在场时的 zh 兜底）
  i18n?: string;                       // 可选 strings.ts key（「横/竖/照片/明信片」值得翻译）
  kind: "print" | "screen" | "pixel";  // 同时是 optgroup 分组
  w: number; h: number;                // unit 下的数值
  unit: "px" | "mm" | "in";
  dpi?: number;                        // print 类必填；导出 pHYs 用
}

const MM_PER_IN = 25.4;

// kind → optgroup 的 i18n key（分组文案本来就在 strings.ts，json 不重复一份）
const GROUP_I18N: Record<CanvasTemplate["kind"], Key> = {
  screen: "nd.grp.painting",
  print:  "nd.grp.print",
  pixel:  "nd.grp.pixel",
};

let _templates: CanvasTemplate[] = [];
let _inflight: Promise<void> | null = null;

/** 测试注入点（node 环境没有可 fetch 的 json asset）。 */
export function _adoptCanvasTemplates(list: CanvasTemplate[]): void {
  _templates = list;
}

/** 加载 json（幂等；失败只 log——SW 已 precache，首访失败下次调用会重试）。 */
export function loadCanvasTemplates(): Promise<void> {
  if (_templates.length) return Promise.resolve();
  if (!_inflight) {
    _inflight = (async () => {
      try {
        const url = new URL("./canvas-templates.json", document.baseURI).href;
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (!Array.isArray(j?.templates)) throw new Error("canvas-templates.json 格式不对");
        _adoptCanvasTemplates(j.templates as CanvasTemplate[]);
      } catch (e) {
        reportError(new Error("[canvas-templates] canvas-templates.json 加载失败 → 本次尺寸模板列表为空"
          + "（自定义尺寸仍可用；下次调用会重试）。" + String(e)), "log");
      }
    })().finally(() => { _inflight = null; });
  }
  return _inflight;
}
// 浏览器模块加载即预热；node 纯测试环境跳过（测试走 _adoptCanvasTemplates）。
if (typeof document !== "undefined" && typeof fetch === "function") void loadCanvasTemplates();

export function allTemplates(): CanvasTemplate[] {
  return _templates;
}

export function templateById(id: string): CanvasTemplate | null {
  return _templates.find((tp) => tp.id === id) ?? null;
}

/** 模板 → 目标像素尺寸（print 类按 DPI 换算，round 到整像素）。 */
export function templatePx(tp: CanvasTemplate): { w: number; h: number } {
  if (tp.unit === "px") return { w: Math.round(tp.w), h: Math.round(tp.h) };
  const dpi = tp.dpi ?? 300;
  const inW = tp.unit === "mm" ? tp.w / MM_PER_IN : tp.w;
  const inH = tp.unit === "mm" ? tp.h / MM_PER_IN : tp.h;
  return { w: Math.max(1, Math.round(inW * dpi)), h: Math.max(1, Math.round(inH * dpi)) };
}

/** 显示文本：i18n（有则用）+ 物理单位模板自动追加换算出的像素数（label 里手写会漂移）。 */
export function templateLabel(tp: CanvasTemplate): string {
  // json 里的 key 是运行时字符串（tsc 管不到）；t() 对未知 key 自带兜底，且
  // canvas-templates.test.ts 有一条守「json 引用的 key 四语齐全」。
  const base = tp.i18n ? t(tp.i18n as Key) : tp.label;
  if (tp.unit === "px") return base;
  const px = templatePx(tp);
  return `${base}（${px.w} × ${px.h}）`;
}

/**
 * 把模板表投影进一个 <select>：按 kind 分 optgroup，末尾追加「自定义…」。
 * 两个消费面（新建作品 / 裁剪模板模式）共用这一份渲染，**显示完全一样的列表**
 * （v0.7.34 user 定；此前有个 surfaces 分面白名单，已连同机制一起删掉）。
 * json 是 async fetch 的 → 调用方在 loadCanvasTemplates() resolve 后调；重复调用幂等（先清空再填）。
 */
export function fillTemplateSelect(sel: HTMLSelectElement, customLabel: string): void {
  const keep = sel.value;
  sel.textContent = "";
  let group: HTMLOptGroupElement | null = null;
  let groupKind: CanvasTemplate["kind"] | null = null;
  for (const tp of _templates) {
    if (tp.kind !== groupKind) {
      group = document.createElement("optgroup");
      group.label = t(GROUP_I18N[tp.kind]);
      sel.appendChild(group);
      groupKind = tp.kind;
    }
    const o = document.createElement("option");
    o.value = tp.id;
    o.textContent = templateLabel(tp);
    group!.appendChild(o);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = customLabel;
  sel.appendChild(custom);
  // 填表可能发生在用户已选好之后（异步 fetch 回来才渲染）——尽量把选择还原回去。
  if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
}
