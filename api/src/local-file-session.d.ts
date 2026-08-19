/** File System Access 句柄的最小面（lib.dom 版本差异大，自带声明 + 运行时探测）。 */
export interface LocalFileHandle {
    readonly name: string;
    readonly kind?: string;
    getFile(): Promise<File>;
    createWritable(): Promise<{
        write(b: Blob): Promise<void>;
        close(): Promise<void>;
    }>;
    requestPermission?(o: {
        mode: string;
    }): Promise<string>;
}
export declare function supportsFileSystemAccess(): boolean;
/** 系统文件选择器挑一个 .ora。用户取消 → null（不是错误）。 */
export declare function pickLocalOraFile(): Promise<LocalFileHandle | null>;
/** 读句柄当前字节（File 自带 name/lastModified，打开时顺手拿 mtime 基线）。 */
export declare function readHandleFile(h: LocalFileHandle): Promise<File>;
/** 句柄当前 mtime（写前陈旧对表用）。读不到（句柄失效等）→ null，调用方自行决定敢不敢写。 */
export declare function handleMtime(h: LocalFileHandle): Promise<number | null>;
/** 写回本地文件。首写时要 readwrite 权限（必须在 user gesture 内调，Ctrl+S/按钮天然满足）。 */
export declare function writeHandleBlob(h: LocalFileHandle, blob: Blob): Promise<void>;
/** drop 事件里挑出第一个 .ora 的文件系统句柄。
 *  ⚠ DataTransferItemList 在事件处理器首个 await 之后失效——getAsFileSystemHandle 的调用
 *  必须**同步**发生；本函数同步收集全部 promise，await 留给返回值。不支持（Safari/Firefox）→ null。 */
export declare function droppedOraHandle(dt: DataTransfer | null): Promise<LocalFileHandle | null>;
/** 安装态 PWA 的「双击 .ora 用 WebPaint 打开」（manifest file_handlers）。浏览器缓存 launch 事件，
 *  boot 后再 setConsumer 也收得到。非安装态/不支持 → 静默 no-op。 */
export declare function consumeLaunchFiles(cb: (h: LocalFileHandle) => void): void;
/** WebPaint 痕迹检测（纯函数）：decode 出的 ora 带我们任一 sidecar/元数据 → 是 WebPaint 写的 →
 *  可原位编辑。外来 ora（Krita 等）三样全无 → 走导入（绝不用我们的有损解读原位覆写别人的文件）。 */
export declare function hasWebPaintTraces(loaded: {
    _webpaintState?: unknown;
    _editorState?: unknown;
    _wroteWith?: unknown;
}): boolean;
