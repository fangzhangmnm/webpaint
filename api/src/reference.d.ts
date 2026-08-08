import type { GestureViewport } from "./pointer-gesture.ts";
import type { PaintingView } from "./workpiece/painting-view.ts";
type RefViewport = GestureViewport;
interface ReferenceWindowOpts {
    panel: HTMLElement;
    head: HTMLElement;
    body: HTMLElement;
    canvas: HTMLElement;
    closeBtn: HTMLElement;
    emptyHint: HTMLElement | null;
    status?: (msg: string, isError?: boolean) => void;
    getTool?: () => string | null;
    getLongPressPickEnabled?: () => boolean;
    onColorSampled?: (hex: string) => void;
}
type RefBitmapSource = (ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas) & {
    close?: () => void;
};
interface SetBitmapOpts {
    persistBlob?: Blob | null;
    skipFit?: boolean;
}
interface PanelDragState {
    id: number;
    sx: number;
    sy: number;
    ol: number;
    ot: number;
}
interface GestureStartState {
    midX: number;
    midY: number;
    dist: number;
    angle: number;
    vp: RefViewport;
}
interface PointerPos {
    x: number;
    y: number;
}
export declare class ReferenceWindow {
    panel: HTMLElement;
    head: HTMLElement;
    body: HTMLElement;
    canvas: HTMLCanvasElement;
    closeBtn: HTMLElement;
    emptyHint: HTMLElement | null;
    status: (msg: string, isError?: boolean) => void;
    getTool: () => string | null;
    getLongPressPickEnabled: () => boolean;
    onColorSampled: (hex: string) => void;
    _picking: boolean;
    _longPressTimer: ReturnType<typeof setTimeout> | null;
    _lpStart: PointerPos | null;
    ctx: CanvasRenderingContext2D;
    bitmap: RefBitmapSource | null;
    _bitmapBlob: Blob | null;
    _liveDoc: PaintingView | null;
    _composeCanvas: HTMLCanvasElement | null;
    _liveDirty: boolean;
    vp: RefViewport;
    _raf: number | null;
    _panelDrag: PanelDragState | null;
    _resizeDrag: unknown;
    _pointers: Map<number, PointerPos>;
    _gestureStart: GestureStartState | null;
    _lastLiveComposeT?: number;
    _liveThrottle?: ReturnType<typeof setTimeout> | null;
    _applying: boolean;
    constructor(opts: ReferenceWindowOpts);
    setBitmap(bitmap: RefBitmapSource | null, opts?: SetBitmapOpts): void;
    getPersistBlob(): Blob | null;
    clearBitmap(): void;
    setLiveSource(doc: PaintingView): void;
    isLive(): boolean;
    toggleLive(doc: PaintingView): void;
    _stopLive(): void;
    markLiveDirty(): void;
    _recomposeLive(): boolean;
    open(): void;
    close(): void;
    isOpen(): boolean;
    toggle(): void;
    fitToPanel(): void;
    _sourceSize(): {
        w: number;
        h: number;
    } | null;
    _bind(): void;
    _onDown(e: PointerEvent): void;
    _onMove(e: PointerEvent): void;
    _onUp(e: PointerEvent): void;
    _cancelLongPress(): void;
    _beginPick(e: PointerEvent): void;
    _endPick(): void;
    _pickAt(clientX: number, clientY: number): void;
    _onWheel(e: WheelEvent): void;
    _resizeCanvasToBody(): void;
    _invalidate(): void;
    _render(): void;
    _updateEmptyHint(): void;
    applyRefPanelFromEditorState(): void;
    _savePos(): void;
    _loadPos(): void;
    _saveVp(): void;
    _loadVp(): void;
}
export {};
