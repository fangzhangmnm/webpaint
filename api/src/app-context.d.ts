import type { PaintingView } from "./backend/workpiece/painting-view.ts";
import type { WebPaintBackend } from "./backend/webpaint-backend.ts";
import type { Board } from "./board.ts";
import type { InputController } from "./input.ts";
import type { EditMode } from "./edit-mode.ts";
import type { History } from "./backend/workpiece/history.ts";
import type { LayersFace } from "./backend/layers-face.ts";
import type { PaintingWorkpiece } from "./backend/workpiece/painting-workpiece.ts";
import type { LayerTiles } from "./backend/workpiece/layer-tiles.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
export interface ToolDial {
    size: number;
    opacity?: number;
    activeBrushId?: string | null;
    activeBrushName?: string | null;
    variantId?: string | null;
}
export interface EditorRuntimeState {
    filterBrush: {
        Filter: unknown;
        params: Record<string, unknown>;
        variantId?: string;
        variantLabel?: string;
    } | null;
    color: string;
    longPressPick: boolean;
    singleFingerDraw: boolean;
    pickMode: string;
    checkerboard: boolean;
    toolStates: Record<string, ToolDial>;
}
export interface DialReactive {
    tool: string;
    color: string;
    canDraw: boolean;
    pressureOff: boolean;
}
export interface RackHandle {
    getRackToolKey(tool: string): string;
    findToolBrush(dial: ToolDial): {
        id: string;
        name?: string;
    } | null;
    findToolBrushPure(dial: ToolDial): {
        name?: string;
        size?: {
            max?: number;
        };
    } | null;
    openBrushSettings(id: string): void;
    applyToolState(tool: string): void;
    load(): Promise<unknown>;
    defaultToolStateFor(tool: string): Partial<ToolDial>;
    get(): {
        brushes: unknown[];
    };
    reconcileWithRemote(): Promise<{
        status: string;
        pushed?: boolean;
        error?: unknown;
    }>;
    restoreBuiltins(): Promise<number>;
}
export interface ReferenceWindowHandle {
    clearBitmap?(): void;
    setBitmap?(bitmap: ImageBitmap, opts?: {
        persistBlob?: Blob | null;
        skipFit?: boolean;
    }): void;
    getPersistBlob?(): Blob | null;
    close?(): void;
}
export interface PaletteWindowHandle {
    getSerializedState(): unknown;
    applySerializedState(s: unknown): void;
    clear?(): void;
    close?(): void;
}
import type { GalleryHandle } from "./gallery/gallery.ts";
export type { GalleryHandle };
import type { LeftDialHandle } from "./ui/left-dial.ts";
export type { LeftDialHandle };
export interface CurrentBrushRef {
    readonly value: ResolvedBrush;
}
export interface AppContext {
    state: EditorRuntimeState;
    dialReactive: DialReactive;
    currentBrush: CurrentBrushRef;
    backend: WebPaintBackend;
    editMode: EditMode;
    doc: PaintingView;
    board: Board;
    input: InputController;
    history: History;
    layers: LayersFace;
    wp2: PaintingWorkpiece;
    layerTiles: LayerTiles;
    rack: RackHandle;
    store: import("./app-store.ts").AppStorePort;
    setStatus: (text: string, persist?: boolean) => void;
    withBusy: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
    leftDial: LeftDialHandle;
    updateSaveStatus: () => void;
    isMidOperation: () => boolean;
    pullSettingsAndState: () => void;
    updateZoomLabel: () => void;
    updateNewerBanner: () => void;
    _suppressTransientPanels: (mode: string) => void;
    _restoreTransientPanels: () => void;
    _bringPanelTop: (el: HTMLElement | null) => void;
    _commitTransform: () => void;
    _cancelTransform: () => void;
    selectionToNewLayer: (arg: {
        move: boolean;
    }) => void;
    importImageAsLayer: (file: File, opts?: {
        center?: {
            x: number;
            y: number;
        };
    }) => Promise<void>;
    afterDocChange: () => void;
    referenceWindow: ReferenceWindowHandle;
    paletteWindow: PaletteWindowHandle;
    setColor: (hex: string) => void;
    applyCheckerboard: (on: boolean) => void;
    renderLayersPanel: () => void;
    setGalleryOpen: (open: boolean) => void;
    checkQuotaAndWarn: () => Promise<void>;
    uniqueNameFor: (stem: string) => Promise<string>;
    showFullscreenBusy: (msg?: string) => void;
    hideFullscreenBusy: () => void;
    bgJobs: {
        register(name: string, priority: number, handler: (deadlineTs: number) => "done" | "requeue", opts?: {
            minIdleMs?: number;
        }): () => void;
    };
    readonly gallery: GalleryHandle;
}
