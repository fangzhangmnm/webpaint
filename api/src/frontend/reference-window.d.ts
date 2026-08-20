import type { GestureViewport } from "../common/pointer-gesture.ts";
export type RefViewport = GestureViewport;
export interface RefPanelRect {
    left: number;
    top: number;
    width: number;
    height: number;
}
export type RefBitmapSource = (ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas) & {
    close?: () => void;
};
export interface SetBitmapOpts {
    persistBlob?: Blob | null;
    skipFit?: boolean;
}
export type RefLiveSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
export interface RefLabels {
    load?: string;
    cloud?: string;
    live?: string;
    fit?: string;
    close?: string;
    resize?: string;
    resizeAria?: string;
}
export declare class WpReferenceWindow extends HTMLElement {
    static get observedAttributes(): string[];
    queryLongPressPick: () => boolean;
    private _headEl;
    private _bodyEl;
    private _canvas;
    private _cctx;
    private _emptyEl;
    private _liveBtn;
    private _bitmap;
    private _bitmapBlob;
    private _liveProvider;
    private _liveSource;
    private _liveDirty;
    private _lastLiveComposeT;
    private _liveThrottle;
    private _vp;
    private _raf;
    private _panelDrag;
    private _resizeDrag;
    private _pointers;
    private _gestureStart;
    private _picking;
    private _longPressTimer;
    private _lpStart;
    constructor();
    get open(): boolean;
    set open(v: boolean);
    attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void;
    close(): void;
    get live(): boolean;
    isLive(): boolean;
    get viewport(): RefViewport;
    set viewport(v: RefViewport | null | undefined);
    get rect(): RefPanelRect;
    set rect(o: Partial<RefPanelRect> | null | undefined);
    set labels(l: RefLabels);
    setBitmap(bitmap: RefBitmapSource | null, opts?: SetBitmapOpts): void;
    clearBitmap(): void;
    getPersistBlob(): Blob | null;
    setLiveProvider(provider: () => RefLiveSource | null): void;
    stopLive(): void;
    private _stopLiveInternal;
    private _reflectLive;
    markLiveDirty(): void;
    fitToPanel(): void;
    private _sourceSize;
    private _emit;
    private _emitViewport;
    private _emitRect;
    private _afterShow;
    private _bind;
    private _onDown;
    private _onMove;
    private _onUp;
    private _onWheel;
    private _cancelLongPress;
    private _beginPick;
    private _endPick;
    private _pickAt;
    private _resizeCanvasToBody;
    private _invalidate;
    private _recomposeLive;
    private _render;
    private _updateEmptyHint;
}
export declare const WP_REFERENCE_WINDOW_TAG = "wp-reference-window";
