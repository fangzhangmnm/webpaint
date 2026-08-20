export interface CloudPickerImage {
    path: string;
    name: string;
    size?: number;
    lastModified?: number;
    cached?: boolean;
}
export interface CloudPickerListing {
    images: CloudPickerImage[];
    folderNames: string[];
}
export interface CloudPickerLabels {
    title?: string;
    root?: string;
    empty?: string;
    loading?: string;
    back?: string;
    close?: string;
}
export declare class WpCloudPicker extends HTMLElement {
    #private;
    /** 宿主注入：拿一条图片的缩略图字节（miss = 整图下载自压，宿主管缓存）。null/抛错 → 占位图标。 */
    fetchThumb: ((item: CloudPickerImage) => Promise<Blob | null>) | null;
    constructor();
    get open(): boolean;
    set open(v: boolean);
    get folder(): string;
    set folder(v: string);
    get listing(): CloudPickerListing;
    set listing(v: CloudPickerListing);
    get loading(): boolean;
    set loading(v: boolean);
    set labels(v: CloudPickerLabels);
    disconnectedCallback(): void;
}
export declare const WP_CLOUD_PICKER_TAG = "wp-cloud-picker";
