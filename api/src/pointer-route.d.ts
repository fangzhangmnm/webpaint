export declare function effectiveTool(tool: string, altDown: boolean): string;
export declare function toolToRole(et: string): string;
export interface PointerDownInput {
    tool: string;
    pointerType: string;
    button: number;
    buttons: number;
    spaceDown: boolean;
    altDown: boolean;
    penEverSeen: boolean;
    singleFingerDraw: boolean;
}
export declare function assignRole({ tool, pointerType, button, buttons, spaceDown, altDown, penEverSeen, singleFingerDraw }: PointerDownInput): string | null;
export declare const ERASER_HOLD_TAP_MS = 350;
export declare function strokeMode(role: string, eraserHold: boolean): "erase" | "brush";
export declare function eraserTapOnRelease(heldMs: number, holdUsed: boolean): boolean;
