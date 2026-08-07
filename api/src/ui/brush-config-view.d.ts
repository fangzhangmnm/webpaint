export declare const BrushSettings: any;
export interface BrushSettingsHandle {
    open(draft: object): void;
    close(): void;
}
export declare function mountBrushSettings(el: HTMLElement, opts: {
    blendModes: Record<string, string>;
    onDelete: () => void;
    onExport: () => void;
}): BrushSettingsHandle;
