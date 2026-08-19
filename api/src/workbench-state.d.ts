import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";
export type EditorState = EditorRuntimeState;
export declare function useDials(): {
    state: EditorRuntimeState;
    dialReactive: DialReactive;
};
export declare function serializedToolStatePatch(current: ToolDial, saved: unknown): Partial<ToolDial> | null;
export interface PanelPos {
    left: number;
    top: number;
    width?: number;
    height?: number;
}
export interface EditorViewport {
    tx: number;
    ty: number;
    scale: number;
    rot: number;
}
declare function freshGroups(): {
    export: {
        format: string;
        target: string;
        layerMode: string;
        clipSelection: boolean;
        defringe: boolean;
        bg: string;
    };
    colorPanel: {
        enabled: boolean;
        position: PanelPos | null;
    };
    layersPanel: {
        enabled: boolean;
        position: PanelPos | null;
    };
    refPanel: {
        enabled: boolean;
        position: PanelPos | null;
        viewport: EditorViewport;
    };
    blenderPanel: {
        show: boolean;
        position: PanelPos | null;
    };
    brushTool: {
        activeBrushId: string | null;
        size: number;
        opacity: number;
        color: string;
    };
    magicWand: {
        threshold: number;
        expand: boolean;
        expandPx: number;
        similarThreshold: number;
        metric: string;
        fillGap: boolean;
        fillGapPx: number;
        lineartCloseDist: number;
        lineartInk: number;
        lineartMinRegion: number;
        lineartTipSens: number;
        lineartBleed: number;
    };
    lassoTool: {
        sub: string;
        setOp: string;
        constrainSquare: boolean;
        algo: string;
        showAnts: boolean;
    };
    fillTool: {
        sub: string;
        setOp: string;
        constrainSquare: boolean;
        algo: string;
        showAnts: boolean;
    };
    shapeBrush: {
        sub: string;
        constrainLine: boolean;
        constrainRect: boolean;
        constrainCircle: boolean;
        gridNu: number;
        gridNv: number;
        gridBorder: boolean;
    };
    persp: {
        mode: string;
        lockHorizon: boolean;
        plane: string;
        showGizmo: boolean;
        p1: {
            vp1: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        p2: {
            vp1: {
                x: number;
                y: number;
            } | null;
            vp2: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        p3: {
            vp1: {
                x: number;
                y: number;
            } | null;
            vp2: {
                x: number;
                y: number;
            } | null;
            vp3: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        iso: {
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
    };
    toolDials: unknown;
    palette: unknown;
    blender: unknown;
    grid: {
        on: boolean;
        cell: number;
    };
    crop: {
        templateId: string;
    };
    liquify: {
        bleed: string;
        sample: string;
    };
    colorPicker: {
        layerMode: string;
    };
    viewport: EditorViewport | null;
    checkboard: boolean;
    pressureDisabled: boolean;
};
export type EditorGroups = ReturnType<typeof freshGroups>;
interface EngineBind {
    getSize(): number;
    setSize(v: number): void;
    getOpacity(): number;
    setOpacity(v: number): void;
    getActiveBrushId(): string | null;
    setActiveBrushId(v: string | null): void;
    getColor(): string;
    setColor(v: string): void;
    getPickMode(): string;
    setPickMode(v: string): void;
    getPressureOff(): boolean;
    setPressureOff(v: boolean): void;
}
export declare function bindEditorReactive(b: EngineBind): void;
export declare const desk: {
    export: {
        format: string;
        target: string;
        layerMode: string;
        clipSelection: boolean;
        defringe: boolean;
        bg: string;
    };
    colorPanel: {
        enabled: boolean;
        position: PanelPos | null;
    };
    layersPanel: {
        enabled: boolean;
        position: PanelPos | null;
    };
    refPanel: {
        enabled: boolean;
        position: PanelPos | null;
        viewport: EditorViewport;
    };
    blenderPanel: {
        show: boolean;
        position: PanelPos | null;
    };
    brushTool: {
        activeBrushId: string | null;
        size: number;
        opacity: number;
        color: string;
    };
    lassoTool: {
        sub: string;
        setOp: string;
        constrainSquare: boolean;
        algo: string;
        showAnts: boolean;
    };
    fillTool: {
        sub: string;
        setOp: string;
        constrainSquare: boolean;
        algo: string;
        showAnts: boolean;
    };
    magicWand: {
        threshold: number;
        expand: boolean;
        expandPx: number;
        similarThreshold: number;
        metric: string;
        fillGap: boolean;
        fillGapPx: number;
        lineartCloseDist: number;
        lineartInk: number;
        lineartMinRegion: number;
        lineartTipSens: number;
        lineartBleed: number;
    };
    shapeBrush: {
        sub: string;
        constrainLine: boolean;
        constrainRect: boolean;
        constrainCircle: boolean;
        gridNu: number;
        gridNv: number;
        gridBorder: boolean;
    };
    persp: {
        mode: string;
        lockHorizon: boolean;
        plane: string;
        showGizmo: boolean;
        readonly p1: {
            vp1: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        readonly p2: {
            vp1: {
                x: number;
                y: number;
            } | null;
            vp2: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        readonly p3: {
            vp1: {
                x: number;
                y: number;
            } | null;
            vp2: {
                x: number;
                y: number;
            } | null;
            vp3: {
                x: number;
                y: number;
            } | null;
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
        readonly iso: {
            box: {
                A: {
                    x: number;
                    y: number;
                };
                t: [number, number, number];
            } | null;
        };
    };
    grid: {
        on: boolean;
        cell: number;
    };
    liquify: {
        bleed: string;
        sample: string;
    };
    crop: {
        templateId: string;
    };
    colorPicker: {
        layerMode: string;
    };
    viewport: EditorViewport | null;
    checkboard: boolean;
    pressureDisabled: boolean;
    Serialize(): EditorGroups;
    Unserialize(json: unknown): void;
    reset(): void;
    readonly toolDials: unknown;
    readonly palette: unknown;
    readonly blender: unknown;
    syncRuntimeForSave(vp: EditorViewport, checkboard: boolean, extra?: {
        toolDials?: unknown;
        palette?: unknown;
        blender?: unknown;
    }): void;
};
export type DeskStruct = typeof desk;
export declare function remapShapePersp(f: (p: {
    x: number;
    y: number;
}) => {
    x: number;
    y: number;
}, opts?: {
    unlockHorizon?: boolean;
}): void;
export declare function snapshotShapePersp(): unknown;
export declare function restoreShapePersp(snap: unknown): void;
export {};
