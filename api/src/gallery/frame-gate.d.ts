export interface FrameGateTimers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
export interface FrameGate<T> {
    push(frame: T): void;
    pointerDown(): void;
    pointerUp(): void;
    reset(): void;
    isHeld(): boolean;
}
export declare function createFrameGate<T>(apply: (frame: T) => void, opts?: {
    tailMs?: number;
    maxHoldMs?: number;
    timers?: FrameGateTimers;
}): FrameGate<T>;
