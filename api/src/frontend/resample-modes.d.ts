export declare const RESAMPLE_MODES: {
    id: string;
    labelKey: string;
    contexts: string[];
}[];
export declare function fillResampleSelect(sel: HTMLSelectElement | null, context: string | null, selected: string, label?: (key: string) => string): void;
