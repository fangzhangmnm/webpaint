interface Cap {
    canDraw: boolean;
    allowsColor: boolean;
    cursor: string;
    ctrlZ: string;
    transient: boolean;
    onToolSwitch?: string;
    returnTo?: string | null;
}
interface TransientHooks {
    apply: (() => void) | null;
    abort: (() => void) | null;
}
export declare class EditMode {
    _current: string;
    _returnTool: string;
    _transient: TransientHooks | null;
    constructor({ initialTool }?: {
        initialTool?: string;
    });
    current(): string;
    _cap(): Cap;
    isTransient(): boolean;
    canDraw(): boolean;
    allowsColor(): boolean;
    cursor(): string;
    showsBrushCursor(): boolean;
    ctrlZMeans(): string;
    _targetTool(): string;
    setTool(tool: string): void;
    enterTransient(name: string, { apply, abort }?: Partial<TransientHooks>): void;
    exitTransient(): void;
    applyPendingTransient(): void;
    abortTransient(): void;
    hasPendingTransient(): boolean;
    _clearTransient(action: string): boolean;
    _emit(): void;
}
export {};
