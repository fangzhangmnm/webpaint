// 面板互斥管理。详 conversation v79→v80 + docs/20260528-sync-design.md 类似的状态模型。
//
// 三层 panel：
//   1. 常驻（颜色、参考）—— 不进这管，自己 toggle，不被关
//   2. 互斥（exclusive）—— 这里管。一次 1 个。开第二个自动关第一个
//   3. Modal —— 见 sync gate / openConfirmSheet 等独立路径
//
// API：
//   registerPanel(id, { show, hide })
//   openExclusive(id) —— 切到这个 panel；如果已经是它就关掉（toggle）
//   closeExclusive() —— 关全部
//   getCurrentExclusive() —— 当前开的 id 或 null
//
// 画布 pointerdown 默认关全部（user：「画画时别让 panel 挡着」）。
// 在 panel 内 click 不要冒泡到 canvas（panel 自己 stopPropagation）。


interface PanelHandlers {
  show?: () => void;
  hide?: () => void;
}

const handlers = new Map<string, PanelHandlers>();
let currentOpen: string | null = null;

export const PANELS = {
  RACK_BRUSH: "rack-brush",
  RACK_ERASER: "rack-eraser",
  RACK_AIRBRUSH: "rack-airbrush",
  RACK_FILTER_BRUSH: "rack-filter-brush",   // v132 filter brush 用的 rack
  LAYERS: "layers",
  BRUSH_SETTINGS: "brush-settings",
  ADJUST: "adjust",
  MENU: "menu",
};

export function registerPanel(id: string, { show, hide }: PanelHandlers) {
  handlers.set(id, { show, hide });
}

export function openExclusive(id: string) {
  if (currentOpen === id) { closeExclusive(); return; }
  if (currentOpen) {
    const h = handlers.get(currentOpen);
    if (h?.hide) h.hide();
  }
  currentOpen = id;
  const h = handlers.get(id);
  if (h?.show) h.show();
}

export function closeExclusive() {
  if (!currentOpen) return;
  const h = handlers.get(currentOpen);
  if (h?.hide) h.hide();
  currentOpen = null;
}

export function getCurrentExclusive() { return currentOpen; }

// （onExclusiveChange + listeners + notifyListeners 整条监听链已删 v415：
//   onExclusiveChange 是 listeners 的**唯一** add 入口且零订阅者 → listeners 恒空、通知恒空转。）

