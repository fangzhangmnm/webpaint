// Engine dispatch 的 SSoT（K1，见 docs/reports/20260606-fresh-geological-survey.html）。
//
// 背景：CONTEXT.md 把 Engine 写成「统一节律 begin/extend/end/cancel」的一道接缝，
// 但在 input.js 里这道接缝曾是**假的**——同一组 pixel-stroke role 的成员判定
//   `role === "draw" || role === "erase" || role === "liquify" || role === "filterBrush"`
// 散在 _down / _move / _up 至少 4 处，每处都要记得列全；per-role 策略
// （丢帧 coalesceLatest、是否喂 brushSettings、finalize、history 事务类型）也散落。
// 加一个引擎要在多处同改，且无任何测试。
//
// 这张表把「dispatch 决策」收成**纯数据**：input 只问表，不再在多处复述成员集合。
// extend / end / flushDirty 在 input.js 早已统一走 _activeStroke.engine.*（不按 role 重新分支），
// 所以这里只覆盖**仍然分支的那部分**：成员判定 + begin 期策略。
//
// 不在此表内的 role（lasso / pick / pan / gesture）**不是 pixel-stroke**：
// 它们生命周期不同（路径 / gizmo / 取色 / 平移），各有专门分支，不应假装成 stamp 引擎。
//
// 每个 spec 字段（纯数据，与具体 engine 实例无关）：
//   engineKey         begin 时用哪个引擎实例（input 上的 this[engineKey]）。draw/erase 共用 brush。
//   coalesceLatest    pointermove 的 coalesced 批是否只跑最后一个
//                     （液化 / filterBrush 每帧 ~31K typed-array ops，整批连跑会堆帧 → 丢帧只保最新）。
//   usesBrushSettings _move 是否取 getBrushSettings() 喂四件套平滑（液化 / filterBrush 传 null）。
//   finalize          endStroke 时是否按选区 applyMaskPostStroke
//                     （filterBrush 在 begin 已吃 selection，故 false）。
//   historyType       PixelEdit.begin 的事务类型（handler 见 pixel-edit.js）。
export const PIXEL_STROKE_SPECS = Object.freeze({
  draw:        Object.freeze({ engineKey: "brush",       coalesceLatest: false, usesBrushSettings: true,  finalize: true,  historyType: "stroke" }),
  erase:       Object.freeze({ engineKey: "brush",       coalesceLatest: false, usesBrushSettings: true,  finalize: true,  historyType: "stroke" }),
  liquify:     Object.freeze({ engineKey: "liquify",     coalesceLatest: true,  usesBrushSettings: false, finalize: true,  historyType: "liquify" }),
  filterBrush: Object.freeze({ engineKey: "filterBrush", coalesceLatest: true,  usesBrushSettings: false, finalize: false, historyType: "stroke" }),
});

// role 是否走 pixel-stroke 生命周期（begin → extend×N → end/abort，落 layer 像素 + PixelEdit 事务）。
export function isPixelStroke(role) {
  return Object.prototype.hasOwnProperty.call(PIXEL_STROKE_SPECS, role);
}

// 取某 role 的 spec；非 pixel-stroke 返回 null。
export function pixelStrokeSpec(role) {
  return PIXEL_STROKE_SPECS[role] || null;
}
