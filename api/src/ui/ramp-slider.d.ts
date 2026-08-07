export interface RampSeg {
    upTo: number;
    step: number;
}
/** 段表 → 档位值序列（含 min 起点；各段 (prev, upTo] 按 step 出档）。 */
export declare function segValueTable(min: number, segs: RampSeg[]): number[];
/** 最近档位索引（值→位置回灌；表短，线性扫够了）。 */
export declare function nearestSegPos(vals: number[], v: number): number;
export interface RampSliderOpts {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onInput: (v: number) => void;
    /** 拖动/键盘一次调整结束（coalescing history 用）。 */
    onCommit?: (v: number) => void;
    fmt?: (v: number) => string;
    /** track 的 CSS background（color ramp）。缺省 = 素色 track。 */
    gradient?: string;
    ariaLabel?: string;
    /** v0.7.22 分段步长模式：设了则位置空间=档位索引（step 忽略，键盘=±1 档）。min 是起点，
        段表须覆盖到 max。低端细高端粗的量（容差/笔粗）用这个，别用连续曲线（量化后必出死区/跳档）。 */
    segments?: RampSeg[];
}
export interface RampSliderHandle {
    el: HTMLLabelElement;
    get(): number;
    set(v: number): void;
    dispose(): void;
}
export declare function makeRampSlider(o: RampSliderOpts): RampSliderHandle;
