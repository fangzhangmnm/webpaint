import type { Brush, BrushRackData } from "./brush-types.ts";
export declare function shareOrDownloadJSON(blob: Blob, filename: string, title?: string): Promise<void>;
export declare function exportBrush(brush: Brush): Promise<void>;
export declare function exportRackFolder(rack: BrushRackData, tool: string, folder: string): Promise<number>;
export declare function buildRackCode(rack: BrushRackData): string;
