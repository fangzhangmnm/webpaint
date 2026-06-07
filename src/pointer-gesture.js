// 纯手势数学（K3 安全切片，见 docs/reports/20260606-fresh-geological-survey.html）。
//
// input.js 把「指针态机」（pointers Map / 事件绑定 / role 路由 / 防误触）和「手势文法」
// （双指变换、旋转吸附、tap 判定）糊在一起。后者是最 fiddly、最易**静默回归**、却**零测**
// 的部分——双指 anchor-preserving 变换错一个符号，画面就跟手跑偏，桌面难复现、只能 iPad 抓。
//
// 这里把手势文法收成**纯函数**（给数字 → 出数字，无 DOM / 无 board / 无 canvas）→ 可单测。
// **不**动 live 派发（那是设备态机，需真机验，留 input.js）。input 只在 _updateGesture /
// _endGesture / _up 的 tap 分支调这些函数，行为逐字保持。

// ---- 两个共享 kernel（board 与参考窗都用；最易错符号、过去各抄一份的那段三角）----

// 双指 scale+rot 增量：两 caller 完全相同的部分。
//   start = { dist, angle, vp:{scale,rot} }（caller 拍的起手快照；mid/坐标系各自管）
//   dist/angle = 当前两指的连线长度/角度
//   → { scale（已夹 [minScale,maxScale]）, rot（已把角度差归一化到 [-π,π] 再叠加）}
export function pinchScaleRot(start, dist, angle, minScale, maxScale) {
  const scale = Math.max(minScale, Math.min(maxScale, start.vp.scale * (dist / start.dist)));
  let dRot = angle - start.angle;
  if (dRot > Math.PI) dRot -= 2 * Math.PI;
  if (dRot < -Math.PI) dRot += 2 * Math.PI;
  return { scale, rot: start.vp.rot + dRot };
}

// anchor-preserving 平移解（origin-affine：screen = scale·R(rot)·model + (tx,ty)）：
// 求 (tx,ty) 让固定的 model 点落到屏幕 (screenX, screenY)。
// board pinch / 参考窗 pinch / 参考窗 wheel 三处都是这段，过去各抄一份。
export function solveAnchorTranslation(modelPt, scale, rot, screenX, screenY) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return {
    tx: screenX - (modelPt.x * scale * c - modelPt.y * scale * s),
    ty: screenY - (modelPt.x * scale * s + modelPt.y * scale * c),
  };
}

// 双指 anchor-preserving 变换（board / 主画布 = doc-center 约定）：起手锚点在新视口下仍落当前两指中点。
//   start = { dist, midX, midY, angle, vp:{tx,ty,scale,rot} }   （_beginGesture 拍的起手快照）
//   a, b  = 当前两指 {x,y}（screen）；limits = { minScale, maxScale, docW, docH }
//   → 新 viewport { tx, ty, scale, rot }
// 旋转**不**在此 snap（进行中吸附会粘手）；松手吸附交给 snapRotation。
// 共享三角走 pinchScaleRot + solveAnchorTranslation；这里只剩 board 自己的 doc-center 记账。
export function computePinchViewport(start, a, b, limits) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angle = Math.atan2(dy, dx);
  const { scale, rot } = pinchScaleRot(start, dist, angle, limits.minScale, limits.maxScale);
  // 起手 g.midX/g.midY 对应的 doc 点（board.screenToDoc 逆运算），减 doc 中心 → origin-affine 的 model 点
  const g = start;
  const W = limits.docW, H = limits.docH;
  const startDocCenterX = g.vp.tx + W * g.vp.scale / 2;
  const startDocCenterY = g.vp.ty + H * g.vp.scale / 2;
  const sdx = g.midX - startDocCenterX, sdy = g.midY - startDocCenterY;
  const sc = Math.cos(-g.vp.rot), ss = Math.sin(-g.vp.rot);
  const dpX = (sdx * sc - sdy * ss) / g.vp.scale + W / 2;
  const dpY = (sdx * ss + sdy * sc) / g.vp.scale + H / 2;
  const cen = solveAnchorTranslation({ x: dpX - W / 2, y: dpY - H / 2 }, scale, rot, midX, midY);
  // board.tx/ty 存的是「doc 左上角 ± 中心」记账 → 把 origin 解换回 board 约定
  return { tx: cen.tx - W * scale / 2, ty: cen.ty - H * scale / 2, scale, rot };
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
