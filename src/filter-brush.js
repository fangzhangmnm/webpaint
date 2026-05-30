// Filter brush 引擎（v132+）—— 薄 delegate
//
// 设计（user：「liquify 也走 filter brush engine」）：
//   引擎不写算法，只管 stroke 生命周期 + dispatch 到 Filter 的 brush 方法。
//   - blur / sharpen 这类"色彩转换"filter：用 attachColorBrushBehavior helper（filters.js）
//     自动得到 spacing + stamp alpha + bake + blend 通用实现
//   - liquify 这类"位移场"filter：自己实现 beginBrushStroke / extendBrushStamp / endBrushStroke
//     （或包装现有 LiquifyEngine）
//
// Filter 必须实现的（brush 模式）：
//   beginBrushStroke(layer, params, brushSettings, selection, x, y, pressure) → state
//   extendBrushStamp(state, x, y, pressure)              每个 pointermove 调，filter 自管 spacing
//   endBrushStroke(state)                                释放
//   cancelBrushStroke?(state)                            可选，取消（abort 路径）
//   flushDirty?(state) → [x0,y0,x1,y1] | null            可选，告诉 board dirty bbox

export class FilterBrushEngine {
  constructor() {
    this._handle = null;
    this._Filter = null;
  }

  beginStroke(layer, Filter, params, brushSettings, selection, x, y, pressure) {
    if (!Filter || !Filter.beginBrushStroke) {
      throw new Error(`Filter ${Filter && Filter.id} 不支持 brush 模式`);
    }
    this._Filter = Filter;
    this._handle = Filter.beginBrushStroke(layer, params, brushSettings, selection, x, y, pressure);
  }

  extendStroke(x, y, pressure) {
    if (!this._handle) return;
    this._Filter.extendBrushStamp(this._handle, x, y, pressure);
  }

  endStroke() {
    if (!this._handle) return;
    this._Filter.endBrushStroke?.(this._handle);
    this._handle = null;
    this._Filter = null;
  }

  cancelStroke() {
    if (!this._handle) return;
    (this._Filter.cancelBrushStroke || this._Filter.endBrushStroke)?.(this._handle);
    this._handle = null;
    this._Filter = null;
  }

  flushDirty() {
    if (!this._handle) return null;
    return this._Filter.flushDirty?.(this._handle) ?? null;
  }

  isActive() { return !!this._handle; }
}
