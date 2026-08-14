import { type RackMeta } from "./brushes.ts";
import { mountBrushSettings } from "./ui/brush-config-view.ts";
import type { Brush, BrushRackData } from "./brush-types.ts";
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";
import type { EditMode } from "./edit-mode.ts";
import type { Collection } from "./app-store.ts";
export interface BrushRackDeps {
    collection: Collection;
    state: EditorRuntimeState;
    dialReactive: DialReactive;
    editMode: () => EditMode;
    setStatus: (text: string, persist?: boolean) => void;
    confirm: (title: string, msg: string) => Promise<boolean>;
    openExclusive: (id: string) => void;
    closeExclusive: () => void;
    registerPanel: (id: string, h: {
        show: () => void;
        hide: () => void;
    }) => void;
    isSignedIn: () => boolean;
    isOnline: () => boolean;
}
interface RackEls {
    mount: HTMLElement;
    title: HTMLElement;
    sheet: HTMLElement;
    close: HTMLElement;
    newBtn: HTMLElement;
    importBtn: HTMLElement;
    refreshBtn?: HTMLElement;
    exportFolderBtn?: HTMLElement;
    resetBtn?: HTMLElement;
    dumpCodeBtn?: HTMLElement;
}
interface SettingsEls {
    view: HTMLElement;
    body: HTMLElement;
    save: HTMLElement;
    cancel: HTMLElement;
}
export interface BrushRackUI {
    els: {
        rack: RackEls;
        settings: SettingsEls;
    };
    blendModes: Record<string, string>;
    RACK_PANEL_BY_TOOL: Record<string, string>;
}
export declare class BrushRackController {
    d: BrushRackDeps & BrushRackUI;
    ui: {
        tool: string;
        folder: string;
    };
    _editingId: string | null;
    _editingDraft: Brush | null;
    _bulkWrite: boolean;
    _settingsUI: ReturnType<typeof mountBrushSettings> | null;
    constructor(deps: BrushRackDeps);
    _brushesRef: import("../vendor/vue/vue.esm-browser.prod.js").Ref<Brush[]>;
    _metaRef: import("../vendor/vue/vue.esm-browser.prod.js").Ref<RackMeta>;
    _syncFromCollection(): void;
    _view(): BrushRackData;
    _meta(): RackMeta;
    get(): BrushRackData;
    _loadPromise: Promise<BrushRackData> | null;
    load(): Promise<BrushRackData>;
    _load(): Promise<BrushRackData>;
    _healTimer: ReturnType<typeof setTimeout> | null;
    _healAttempt: number;
    _healOnline: (() => void) | null;
    static HEAL_DELAYS_MS: number[];
    _healEmptyRack(): Promise<void>;
    _scheduleHeal(): void;
    _stopHeal(): void;
    /** collection → 笔架的**唯一**绑定。本地写和云端写在 store 层已一视同仁，这里也不分。
     *  放在 load()（数据层）而非 init()（要 DOM）：绑定与 UI 无关，且这样才能 node 测。 */
    subscribeToCollection(): void;
    reconcileWithRemote(): Promise<import("@internal/store").ReconcileResult>;
    getRackToolKey(tool: string): string;
    defaultToolStateFor(tool: string): {
        size: number;
        opacity: number;
        activeBrushId: string;
        activeBrushName: string;
    } | {
        size: number;
        opacity: number;
        activeBrushId: null;
        activeBrushName: null;
    };
    findToolBrush(ts: ToolDial | null | undefined): Brush | null;
    findToolBrushPure(ts: ToolDial | null | undefined): Brush | null;
    resolveActiveBrushPure(ts: ToolDial | null | undefined, tool: string): Brush | null;
    applyToolState(tool: string): void;
    writeCurrentToolSize(v: number): void;
    writeCurrentToolOpacity(v: number): void;
    selectBrushPresetForTool(tool: string, brushId: string): void;
    showSheet(tool: string): void;
    hideSheet(): void;
    restoreBuiltins(): Promise<number>;
    /** @param silent 后台自愈用：失败只 log，不弹 banner（首开离线是良性场景）。 */
    _restoreBuiltins(silent?: boolean): Promise<number>;
    _nextBrushName(): string;
    _deriveBrushName(srcName: string): string;
    openBrushSettings(brushId: string, newDraft?: Brush): void;
    closeBrushSettings(save: boolean): void;
    _ensureMetaPlacement(id: string, folder: string): void;
    deleteEditingBrush(): Promise<void>;
    moveBrushToFolder(id: string, folder: string): void;
    init(ui: BrushRackUI): void;
    _onNewBrush(): void;
    _onImport(): void;
}
export {};
