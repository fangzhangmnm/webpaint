import type { PaintingView } from "./backend/workpiece/painting-view.ts";
export interface ExportOpts {
    scope?: string;
    cropRect?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | null;
}
export interface Exporter {
    id: string;
    label: string;
    ext: string;
    mime?: string;
    kind: "project" | "image";
    encode: (doc: PaintingView, opts?: ExportOpts) => Promise<Blob>;
    busyHint?: string;
}
export declare function registerExporter(spec: Exporter): void;
export declare function getExporter(id: string): Exporter;
export declare function listExporters(): Exporter[];
export declare function listExportersByKind(kind: string): Exporter[];
