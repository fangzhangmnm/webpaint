// 职责（单一）：锚定 popup 定位 + outside-click 关闭——纯 DOM helper，无 app 状态依赖。
// anchor 下方 / 右对齐定位 + 高 z-index（200 永远 > 所有 modal）+ outside-click 关闭。
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
  popupEl.style.zIndex = "200";
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
