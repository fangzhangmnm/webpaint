interface PanelHandlers {
    show?: () => void;
    hide?: () => void;
}
export declare const PANELS: {
    RACK_BRUSH: string;
    RACK_ERASER: string;
    RACK_AIRBRUSH: string;
    RACK_FILTER_BRUSH: string;
    RACK_SEL_PEN: string;
    LAYERS: string;
    BRUSH_SETTINGS: string;
    ADJUST: string;
    MENU: string;
};
export declare function registerPanel(id: string, { show, hide }: PanelHandlers): void;
export declare function openExclusive(id: string): void;
export declare function closeExclusive(): void;
export declare function getCurrentExclusive(): string | null;
export {};
