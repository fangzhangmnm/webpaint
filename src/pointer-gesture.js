// 纯手势数学（K3 安全切片，见 docs/reports/20260606-fresh-geological-survey.html）。
//
// input.js 把「指针态机」（pointers Map / 事件绑定 / role 路由 / 防误触）和「手势文法」
// （双指变换、旋转吸附、tap 判定）糊在一起。后者是最 fiddly、最易**静默回归**、却**零测**
// 的部分——双指 anchor-preserving 变换错一个符号，画面就跟手跑偏，桌面难复现、只能 iPad 抓。
//
// 这里把手势文法收成**纯函数**（给数字 → 出数字，无 DOM / 无 board / 无 canvas）→ 可单测。
// **不**动 live 派发（那是设备态机，需真机验，留 input.js）。input 只在 _updateGesture /
// _endGesture / _up 的 tap 分支调这些函数，行为逐字保持。

// 双指 anchor-preserving 变换：起手锚点在新视口下仍落在当前两指中点。
//   start = { dist, midX, midY, angle, vp:{tx,ty,scale,rot} }   （_beginGesture 拍的起手快照）
//   a, b  = 当前两指 {x,y}（screen）
//   limits = { minScale, maxScale, docW, docH }
//   → 新 viewport { tx, ty, scale, rot }
// 旋转**不**在此 snap（进行中吸附会粘手）；松手吸附交给 snapRotation。
export function computePinchViewport(start, a, b, limits) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angle = Math.atan2(dy, dx);
  const g = start;
  // scale 增量（夹到 board 缩放区间）
  const k = dist / g.dist;
  let newScale = g.vp.scale * k;
  newScale = Math.max(limits.minScale, Math.min(limits.maxScale, newScale));
  // rotation 增量（两指连线角度差，归一化到 [-π, π]）
  let dRot = angle - g.angle;
  if (dRot > Math.PI) dRot -= 2 * Math.PI;
  if (dRot < -Math.PI) dRot += 2 * Math.PI;
  const newRot = g.vp.rot + dRot;
  // 起手 g.midX/g.midY 对应的 doc 点（board.screenToDoc 逆运算；公式见 board）
  const W = limits.docW, H = limits.docH;
  const startDocCenterX = g.vp.tx + W * g.vp.scale / 2;
  const startDocCenterY = g.vp.ty + H * g.vp.scale / 2;
  const sdx = g.midX - startDocCenterX, sdy = g.midY - startDocCenterY;
  const sc = Math.cos(-g.vp.rot), ss = Math.sin(-g.vp.rot);
  const dpX = (sdx * sc - sdy * ss) / g.vp.scale + W / 2;
  const dpY = (sdx * ss + sdy * sc) / g.vp.scale + H / 2;
  // 求 newTx/newTy 让该 doc 点在新视口下落到当前 midX/midY
  const c = Math.cos(newRot), s = Math.sin(newRot);
  const rx = (dpX - W / 2) * newScale;
  const ry = (dpY - H / 2) * newScale;
  const newCx = midX - (rx * c - ry * s);
  const newCy = midY - (rx * s + ry * c);
  return {
    tx: newCx - W * newScale / 2,
    ty: newCy - H * newScale / 2,
    scale: newScale,
    rot: newRot,
  };
}

// 松手旋转吸附（Procreate：±5° 内吸到 0/90/180/270°）。
//   cur 弧度接近某个 k·90° 且差 < snapDeg° → 返回该吸附角；否则 null（不吸，原样）。
export function snapRotation(cur, snapDeg = 5) {
  const step = Math.PI / 2;
  const snapped = Math.round(cur / step) * step;
  if (cur !== snapped && Math.abs(cur - snapped) < snapDeg * Math.PI / 180) {
    return snapped;
  }
  return null;
}

// tap 判定：短时 + 小位移（单位由 caller 给——screen px / ms）。
export function isTap(durMs, distPx, maxDurMs, maxMovePx) {
  return durMs < maxDurMs && distPx < maxMovePx;
}

// 双击判定：本次 tap 与上次 tap 在时间窗内、且落点相近。
//   prev = { time, x, y } | null
export function isDoubleTap(now, prev, x, y, windowMs, maxGapPx) {
  if (!prev) return false;
  return (now - prev.time) < windowMs &&
    Math.hypot(x - prev.x, y - prev.y) < maxGapPx;
}

// 多指 tap → 动作（Procreate 方言：双指撤销 / 三指+重做）。无匹配 = null。
export function gestureTapAction(maxCount) {
  if (maxCount === 2) return "undo";
  if (maxCount >= 3) return "redo";
  return null;
}
