// 职责（单一）：锚定 popup 定位 + outside-click 关闭——纯 DOM helper，无 app 状态依赖。
// anchor 下方 / 右对齐定位 + popout band（--z-popout 永远 > 所有 modal）+ outside-click 关闭。
// 用 fixed 定位（脱离父 container 限制）。避免每个 popup 个别调 z-index / position。

const _openPopups = new WeakSet();

export function openAnchoredPopup(
  popupEl: any,
  anchorEl: any,
  { alignRight = true, offsetY = 4 }: { alignRight?: boolean; offsetY?: number } = {}
) {
  if (!popupEl || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  popupEl.style.position = "fixed";
  popupEl.style.top = (rect.bottom + offsetY) + "px";
  if (alignRight) {
    popupEl.style.right = (window.innerWidth - rect.right) + "px";
    popupEl.style.left = "auto";
  } else {
    popupEl.style.left = rect.left + "px";
    popupEl.style.right = "auto";
  }
  popupEl.style.zIndex = "var(--z-popout)";   // band 表见 styles.css :root（v232）
  popupEl.classList.remove("hidden");
  _openPopups.add(popupEl);
  // outside click 关闭（一帧后挂，避免本次 click 立刻关）
  const handler = (e: any) => {
    if (popupEl.contains(e.target) || anchorEl.contains(e.target)) return;
    closeAnchoredPopup(popupEl);
    document.removeEventListener("click", handler, true);
  };
  setTimeout(() => document.addEventListener("click", handler, true), 0);
}
export function closeAnchoredPopup(popupEl: any) {
  if (!popupEl) return;
  popupEl.classList.add("hidden");
  _openPopups.delete(popupEl);
}
export function toggleAnchoredPopup(popupEl: any, anchorEl: any, opts?: any) {
  if (_openPopups.has(popupEl)) closeAnchoredPopup(popupEl);
  else openAnchoredPopup(popupEl, anchorEl, opts);
}

export function anchorPopupToBtn(popup: any, btn: any) {
  const r = btn.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.top = (r.bottom + 4) + "px";
  popup.style.right = (window.innerWidth - r.right) + "px";
  popup.style.left = "auto";
}

// 顶部固定工具栏的最大 bottom（lasso stack / crop toolbar / filter brush toolbar
// 都 fixed 在顶栏下方）。fx 弹窗锚在按钮下方时要让到这些条以下，否则遮挡。
// v219：从 setAdjustOpen 的 bespoke lassoToolbarStack 单查抽出，覆盖全部顶栏条。
const _TOP_TOOLBAR_IDS = ["lassoToolbarStack", "cropToolbar", "filterBrushToolbar"];
export function topToolbarBottom() {
  let bottom = 0;
  for (const id of _TOP_TOOLBAR_IDS) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains("hidden")) {
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    }
  }
  return bottom;
}

// 把 popup 锚到按钮下方右对齐，但让到所有可见顶栏条以下；并夹在视口内（避免顶/底溢出）。
export function anchorPopupBelowToolbars(popup: any, btn: any, offsetY = 4) {
  const r = btn.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.right = (window.innerWidth - r.right) + "px";
  popup.style.left = "auto";
  let top = Math.max(r.bottom, topToolbarBottom()) + offsetY;
  // 底部夹：popup 高度已知时不让它掉出视口底（留 8px 边距）
  const h = popup.offsetHeight || 0;
  if (h) top = Math.min(top, Math.max(8, window.innerHeight - h - 8));
  popup.style.top = top + "px";
}
