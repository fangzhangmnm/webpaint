export interface DragValueOpts {
    /** 当前归一化值（相对模式起步锚；1D 宿主只用 x）。 */
    getValue(): {
        x: number;
        y: number;
    };
    /** 每次取值变化回调（fine = 当拍处于 shift 细调）。 */
    onDrag(x: number, y: number, fine: boolean): void;
    /** 拖动结束（up/cancel/buttons 兜底），coalescing-history 类消费者在这里落 undo。 */
    onCommit?(): void;
    /** shift 细调增益，默认 0.15。 */
    fineGain?: number;
}
export interface DragMoveEv {
    clientX: number;
    clientY: number;
    shiftKey: boolean;
}
export interface DragRect {
    left: number;
    top: number;
    width: number;
    height: number;
}
export interface DragState {
    mode: "abs" | "rel";
    x: number;
    y: number;
    lastPx: number;
    lastPy: number;
}
export declare function dragBegin(ev: DragMoveEv, rect: DragRect, cur: {
    x: number;
    y: number;
}): DragState;
export declare function dragMove(st: DragState, ev: DragMoveEv, rect: DragRect, fineGain: number): DragState;
export interface DragValueHandle {
    dispose(): void;
    dragging(): boolean;
}
export declare function attachDragValue(el: HTMLElement, opts: DragValueOpts): DragValueHandle;
