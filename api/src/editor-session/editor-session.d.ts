/** app 的编辑引擎暴露给 editor-session 的最小面。本模块不懂内容，只调这几个。 */
export interface EditorAdapter {
    adopt(bytes: Blob): Promise<void>;
    onChange(cb: () => void): void;
    encode(): Promise<{
        bytes: Blob;
        peek?: Blob | null;
    }>;
    onSaved?(name: string): void;
}
/** editor-session 消费的 store 最小面（结构类型；真 sync-store 天然满足，测试可 mock）。 */
export type TryMoveResult = {
    ok: true;
    where?: string;
    oldName?: string;
    oldKept?: boolean;
    oldUnknown?: boolean;
    oldCloudOrphan?: boolean;
    cloudDeferred?: boolean;
} | {
    ok: false;
    reason: "name-collision";
    where: "local" | "cloud";
};
export interface StoreLike {
    file(name: string, opts: {
        isZip: boolean;
        mode: "new" | "existing";
    }): {
        open(): Promise<Blob | null>;
        save(bytes: Blob, opts?: {
            tryPush?: boolean;
            hint?: unknown;
        }): Promise<{
            pushed: boolean;
            reason?: string;
        }>;
        tryMove(to: string): Promise<TryMoveResult>;
        delete(): Promise<{
            status: string;
        }>;
    };
}
/** app-agnostic 的 autosave / push 策略（每 app 不同 → 注入）。 */
export interface LifecyclePolicy {
    autosaveMs?: number;
    pushOn?: Array<"exit" | "blur" | "idle">;
    idleMs?: number;
}
export interface EditorSessionConfig {
    store: StoreLike;
    editor: EditorAdapter;
    isZip?: boolean;
    policy?: LifecyclePolicy;
}
export interface EditorSession {
    open(name: string): Promise<boolean>;
    adopted(name: string, opts?: {
        create?: boolean;
    }): void;
    markDirty(): void;
    flushLocal(): Promise<void>;
    flushAndPush(): Promise<void>;
    forceSaveAndPush(): Promise<void>;
    rename(newName: string): Promise<TryMoveResult>;
    delete(): Promise<void>;
    currentName(): string | null;
    isDirty(): boolean;
    isPushPending(): boolean;
    start(): void;
    dispose(): void;
}
export declare function createEditorSession(config: EditorSessionConfig): EditorSession;
