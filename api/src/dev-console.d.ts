import { fetchOraThumbnail } from "./cloud-thumbs.ts";
import { registerFilter, listFilters } from "./filters.ts";
import { registerExporter, listExporters } from "./exporters.ts";
declare global {
    interface Window {
        WebPaint?: {
            fetchOraThumbnail?: typeof fetchOraThumbnail;
            cloudThumbStats?: () => unknown;
            cloudThumbResetStats?: () => void;
            cloudThumbSkipCache?: (on?: boolean) => void;
            clearCloudThumbCache?: () => Promise<number>;
            pocFetchThumb?: (name?: string) => Promise<Blob>;
            registerFilter?: typeof registerFilter;
            listFilters?: typeof listFilters;
            registerExporter?: typeof registerExporter;
            listExporters?: typeof listExporters;
            [k: string]: unknown;
        };
    }
}
export declare function initDevConsole(): void;
