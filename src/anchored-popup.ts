// 职责（单一）：弹框锚定定位——所有「跟着按钮 / 顶栏跑」的 popup 的**唯一**定位入口。
// 统一处理：position:fixed + 让到顶栏条以下 + 读 env(safe-area-inset-top)（iPad 日期/状态栏）
//   + 夹进视口（不溢出顶 / 底）。CSS 只管外观，坐标只此一处算 → 杜绝「各 popup 各写一套、漏
//   safe-area / 漏夹视口」那类 iPad 打架 bug（v267 前 fx 选单 top:70、参考窗左上角都栽过同一根因）。
//
// 不含：
//   · lasso 那批「钉死在工具栏正下方居中」的纯 CSS popup —— 位置不随按钮跑，留 CSS 零 JS、零抖动；
//   · modal sheets（sheets.ts，居中 / 底部弹层是另一套系统）。
//
// v270 收敛：原来这里有 3 个近似函数（openAnchoredPopup/anchorPopupToBtn/anchorPopupBelowToolbars，
//   feature 各缺一块）+ settings-menu / filters-adjust 各手搓一份。全部收成 positionPopup 一个核心；
//   旧名留作薄 wrapper（老调用点零改动，白捡 safe-area + 夹视口）。

// env(safe-area-inset-top) 在 JS 拿不到解析后的字面值 → 一次性探针量 padding-top（旋转 / 机型变了也准）。
function safeAreaTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;height:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return v;
}

// 顶部固定工具栏的最大 bottom（lasso stack / crop toolbar / filter brush toolbar 都 fixed 在顶栏下）。
// belowToolbars 的 popup 要让到这些条以下，否则遮挡。
const _TOP_TOOLBAR_IDS = ["lassoToolbarStack", "cropToolbar", "filterBrushToolbar"];
export function topToolbarBottom(): number {
  let bottom = 0;
  for (const id of _TOP_TOOLBAR_IDS) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains("hidden")) {
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    }
  }
  return bottom;
}

interface PositionOpts {
  anchor?: any;            // 锚按钮（量其 bottom/left/right）；null = 不锚按钮，钉视口边
  align?: "left" | "right"; // 右对齐到 anchor.right / 视口右（默认 right）；左同理
  offsetY?: number;        // 锚点下方间距（默认 4）
  edgeMargin?: number;     // 无 anchor 时离视口边的距离（默认 8）
  belowToolbars?: boolean; // 让到所有可见顶栏条以下（fx 选单 / 滤镜面板）
  clampViewport?: boolean; // 夹进视口底，不溢出（默认 true；popup 须已可见才量得到高）
}

// 唯一定位核心。所有按钮锚定 / 边钉的 popup 都走它。
export function positionPopup(popupEl: any, opts: PositionOpts = {}) {
  if (!popupEl) return;
  const {
    anchor = null, align = "right", offsetY = 4,
    edgeMargin = 8, belowToolbars = false, clampViewport = true,
  } = opts;
  popupEl.style.position = "fixed";
  const safeTop = safeAreaTop();
  let top: number;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    top = r.bottom + offsetY;
    if (align === "right") { popupEl.style.right = (window.innerWidth - r.right) + "px"; popupEl.style.left = "auto"; }
    else { popupEl.style.left = r.left + "px"; popupEl.style.right = "auto"; }
  } else {
    top = safeTop + offsetY;
    if (align === "right") { popupEl.style.right = edgeMargin + "px"; popupEl.style.left = "auto"; }
    else { popupEl.style.left = edgeMargin + "px"; popupEl.style.right = "auto"; }
  }
  if (belowToolbars) top = Math.max(top, topToolbarBottom() + offsetY);
  top = Math.max(top, safeTop + 4);                          // safe-area floor：永不钻进 iPad 顶部栏
  if (clampViewport) {
    const h = popupEl.offsetHeight || 0;                     // 已隐藏 → 0 → 跳过夹（与旧行为一致）
    if (h) top = Math.min(top, Math.max(safeTop + 4, window.innerHeight - h - 8));
  }
  popupEl.style.top = top + "px";
}

// ---- 兼容 wrapper：老调用点零改动 ----
// 锚到按钮下方右对齐（图库 新建/云账号/回收站/菜单 popup）。
export function anchorPopupToBtn(popup: any, btn: any, opts: PositionOpts = {}) {
  positionPopup(popup, { anchor: btn, align: "right", ...opts });
}
// 锚到按钮下方右对齐，但让到所有可见顶栏条以下（fx 选单）。
export function anchorPopupBelowToolbars(popup: any, btn: any, offsetY = 4) {
  positionPopup(popup, { anchor: btn, align: "right", belowToolbars: true, offsetY });
}
