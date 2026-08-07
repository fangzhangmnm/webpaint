interface RackBrush {
    folder?: string;
}
export declare function collectFolders(brushes: RackBrush[], defaultFolder: string): string[];
export declare function brushesInFolder<T extends RackBrush>(brushes: T[], folder: string, defaultFolder: string): T[];
export declare function smoothstepRadialGradient(hardness: number, stops?: number): string;
export {};
