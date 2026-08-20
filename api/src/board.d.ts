import type { WarpBakeFn } from "./floating-transform.ts";
import { GLBoard } from "./shell/gl-board.ts";
import type { FloatInput, StampOverlayInput, FillOverlayInput, OverlayInput, SurrogateInput } from "./backend/gl/gl-room.ts";
import type { Stamp, StrokeShape } from "./backend/gl/gl-stamp.ts";
type StampCollect = {
    stamps: Stamp[];
    shape: StrokeShape;
    layer: ViewLeaf;
    mode: string;
    opacity: number;
    blendMode: string;
    bx: number;
    by: number;
    bw: number;
    bh: number;
} | null;
import type { PaintingView, ViewLeaf } from "./backend/workpiece/painting-view.ts";
import type { LayerPixels } from "./backend/tiles/tile-layer.ts";
interface Viewport {
    tx: number;
    ty: number;
    scale: number;
    rot: number;
}
interface Cursor {
    x: number;
    y: number;
    size: number;
    square?: boolean;
    aspect?: number;
    rotation?: number;
}
export interface PerspGizmoData {
    horizon: [{
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }] | null;
    rays: Array<[{
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }]>;
    vps: Array<{
        x: number;
        y: number;
    }>;
    boxEdges?: Array<[{
        x: number;
        y: number;
    }, {
        x: number;
        y: number;
    }]>;
}
import type { Selection } from "./backend/selection.ts";
interface MeshPt {
    x: number;
    y: number;
}
interface FloatSource {
    layerId: number;
    bytes: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    };
    rect: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    spline?: {
        data: Float32Array;
        w: number;
        h: number;
    };
    rotsprite?: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    };
}
interface FloatInfo {
    sources: FloatSource[];
    gizmoFrame: unknown;
    mesh: MeshPt[][];
    meshN: number;
}
interface Handle {
    pos: MeshPt;
    kind?: string;
    anchor?: MeshPt;
}
interface LassoInfo {
    selection?: Selection | null;
    showAnts?: boolean;
    floating?: FloatInfo | null;
    drawingPath?: MeshPt[] | null;
    polyFirst?: MeshPt | null;
    drawingRect?: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    } | null;
    drawingEllipse?: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    } | null;
    handles?: Handle[] | null;
    sampleMode?: string;
    lineartDebug?: {
        w: number;
        h: number;
        keypoints: {
            x: number;
            y: number;
            nx: number;
            ny: number;
            kappa: number;
        }[];
        bridges: {
            px: number[];
            ok: boolean;
            reason?: string;
        }[];
    } | null;
}
type Ctx2D = CanvasRenderingContext2D;
type ViewportChangeCb = (() => void) | null;
export declare class Board {
    canvas: HTMLCanvasElement;
    ctx: Ctx2D;
    doc: PaintingView;
    dpr: number;
    viewport: Viewport;
    onViewportChange: ViewportChangeCb;
    minScale: number;
    maxScale: number;
    _raf: number | null;
    _cursor: Cursor | null;
    _showCursor: boolean;
    _voidColor: string;
    _voidDotColor: string;
    _showCheckerboard: boolean;
    _pixelGridEnabled: boolean;
    _docGridOn: boolean;
    _docGridCell: number;
    gridCanvas: HTMLCanvasElement | null;
    gctx: Ctx2D | null;
    cursorEl: HTMLElement | null;
    _gridSig: string;
    _strokeActiveHint?: (() => unknown) | null;
    _liveSyncProvider?: (() => ViewLeaf | null) | null;
    _lassoProvider?: (() => LassoInfo | null | undefined) | null;
    _activeSurrogateLayerId?: number | null;
    _activeSurrogateBytes?: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
    _activeSurrogateBx?: number;
    _activeSurrogateBy?: number;
    _strokeShadow?: {
        layerId: number;
        pixels: LayerPixels;
    } | null;
    _showFps?: boolean;
    _lastFrameT?: number | null;
    _fps?: number | null;
    _fpsEl?: HTMLElement;
    _lastStampCount: number;
    static _dispatchingDirty?: boolean;
    _glBoard?: GLBoard | null;
    _glCanvas?: HTMLCanvasElement | null;
    constructor(canvas: HTMLCanvasElement, doc: PaintingView);
    _configureDocMemory(): void;
    _setupGLBoard(): void;
    setDoc(doc: PaintingView): void;
    setShowCheckerboard(on: boolean): void;
    setPixelGridEnabled(on: boolean): void;
    getPixelGridEnabled(): boolean;
    setDocGrid(on: boolean, cell: number): void;
    setThemeColors({ voidColor, voidDotColor }: {
        voidColor?: string;
        voidDotColor?: string;
    }): void;
    markDocDirty(_x0: number, _y0: number, _x1: number, _y1: number): void;
    _docCenterScreen(): {
        cx: number;
        cy: number;
    };
    screenToDoc(sx: number, sy: number): {
        x: number;
        y: number;
    };
    docToScreen(dx: number, dy: number): {
        x: number;
        y: number;
    };
    pan(dx: number, dy: number): void;
    _clampPan(): void;
    zoomAt(anchorX: number, anchorY: number, factor: number): void;
    rotateAt(anchorX: number, anchorY: number, deltaRot: number): void;
    setViewport(tx: number, ty: number, scale: number, rot?: number): void;
    fitToScreen(padding?: number): void;
    invalidateAll(): void;
    setStrokeActiveHint(fn: (() => unknown) | null): void;
    setLiveSyncProvider(fn: (() => ViewLeaf | null) | null): void;
    setLassoProvider(fn: (() => LassoInfo | null | undefined) | null): void;
    setActiveLayerSurrogate(layerId: number | null, bytes: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null, bx?: number, by?: number): void;
    setStrokeShadow(layerId: number | null, pixels: LayerPixels | null): void;
    _glSurrogate(): SurrogateInput | null;
    _docTransformParams(): [number, number, number, number, number, number];
    _applyDocTransform(ctx: Ctx2D): void;
    resize(): void;
    requestRender(): void;
    setCursor(c: Cursor | null): void;
    _updateCursorEl(): void;
    render(): void;
    setShowFps(on: boolean): void;
    getShowFps(): boolean;
    _ensureFpsEl(): HTMLElement;
    _tickFps(): void;
    _renderFull(): void;
    _drawGLRequiredMessage(ctx: Ctx2D, W: number, H: number): void;
    _renderFullGL(ctx: Ctx2D, W: number, H: number): void;
    setPerspGizmoProvider(fn: (() => PerspGizmoData | null) | null): void;
    _drawPerspGizmo(ctx: Ctx2D, scale: number): void;
    _stampProvider: (() => StampCollect) | null;
    setStampProvider(fn: () => StampCollect): void;
    _overlayInputFrom(cs: NonNullable<StampCollect>): StampOverlayInput;
    _glStampOverlay(): OverlayInput | null;
    rasterizeStampsToMask(cs: NonNullable<StampCollect>): {
        x: number;
        y: number;
        w: number;
        h: number;
        g: Uint8Array;
    } | null;
    _fillProvider: (() => {
        color: string;
        layer: ViewLeaf;
    } | null) | null;
    _perspGizmoProvider: (() => PerspGizmoData | null) | null;
    setFillProvider(fn: (() => {
        color: string;
        layer: ViewLeaf;
    } | null) | null): void;
    _glFillOverlay(): FillOverlayInput | null;
    _fillInputFrom(f: {
        color: string;
        layer: ViewLeaf;
    }): FillOverlayInput | null;
    isGLBoard(): boolean;
    commitBrushStroke(cs: NonNullable<StampCollect>): boolean;
    commitFill(f: {
        color: string;
        layer: ViewLeaf;
    }): boolean;
    glWarpBakeFn(): WarpBakeFn | null;
    _glFloatInputs(): FloatInput[];
    _isLivePreview(): boolean;
    compositeNodesToCanvas(nodes: readonly unknown[], docW: number, docH: number): HTMLCanvasElement | null;
    compositeNodesToBytes(nodes: readonly unknown[], docW: number, docH: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
    compositeDisplayBytes(nodes: readonly unknown[], docW: number, docH: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
    pickCompositeColor(ix: number, iy: number): [number, number, number, number] | null;
    _drawLassoOverlay(ctx: Ctx2D, scale: number): void;
    _syncGrid(): void;
    _drawGrid(): void;
}
export {};
