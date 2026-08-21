// 无地本地文件模式的**浏览器 API 边界**（File System Access；spec ai-docs/20260819-clipboard-and-local-file-spec.md §7）。
// 壳域合法名单同类成员（与剪贴板/任意格式解码并列：浏览器 API 边界，不可 headless 化）。
// 本文件**零 app 依赖**（不 import session/store/els）——无地状态机在 session-state（_localFile + _esMuted 双墙），
// 这里只有：能力探测 / picker / 句柄读写 / mtime / drop·launchQueue 提取 / WeebPaint 痕迹检测（纯函数，node 可测）。
// 数据安全：写走 createWritable（浏览器临时文件、close 时原子替换）；陈旧检查（mtime 对表）由调用方在写前做。
// 核心路径不依赖 PWA：picker 和 drop 句柄在浏览器标签页全功能；launchQueue/file_handlers 是安装态锦上添花。

/** File System Access 句柄的最小面（lib.dom 版本差异大，自带声明 + 运行时探测）。 */
export interface LocalFileHandle {
  readonly name: string;
  readonly kind?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
  requestPermission?(o: { mode: string }): Promise<string>;
}

export function supportsFileSystemAccess(): boolean {
  return typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
}

/** 系统文件选择器挑一个 .ora。用户取消 → null（不是错误）。 */
export async function pickLocalOraFile(): Promise<LocalFileHandle | null> {
  const picker = (globalThis as unknown as { showOpenFilePicker?: (o: unknown) => Promise<LocalFileHandle[]> }).showOpenFilePicker;
  if (!picker) return null;
  try {
    const got = await picker({
      types: [{ description: "OpenRaster", accept: { "image/openraster": [".ora"] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });
    return got?.[0] ?? null;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return null;   // 用户取消 picker
    throw e;
  }
}

/** showSaveFilePicker 在场探测（Chromium 桌面）。与 open 侧分开探——两 API 支持面可能不同。 */
export function supportsSaveFilePicker(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/** 系统「另存为」框挑 .ora 落点（2026-08-21，「导出与另存」hub 的本地去向用）。
 *  用户取消 → null（不是错误）。必须在 user-gesture 活化窗口内调（调用方先 pick 再 encode）。 */
export async function pickSaveOraFile(suggestedName: string): Promise<LocalFileHandle | null> {
  const picker = (globalThis as unknown as { showSaveFilePicker?: (o: unknown) => Promise<LocalFileHandle> }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return (await picker({
      suggestedName,
      types: [{ description: "OpenRaster", accept: { "image/openraster": [".ora"] } }],
    })) ?? null;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return null;   // 用户取消保存框
    throw e;
  }
}

/** 读句柄当前字节（File 自带 name/lastModified，打开时顺手拿 mtime 基线）。 */
export async function readHandleFile(h: LocalFileHandle): Promise<File> { return h.getFile(); }

/** 句柄当前 mtime（写前陈旧对表用）。读不到（句柄失效等）→ null，调用方自行决定敢不敢写。 */
export async function handleMtime(h: LocalFileHandle): Promise<number | null> {
  try { return (await h.getFile()).lastModified; } catch { return null; }
}

/** 写回本地文件。首写时要 readwrite 权限（必须在 user gesture 内调，Ctrl+S/按钮天然满足）。 */
export async function writeHandleBlob(h: LocalFileHandle, blob: Blob): Promise<void> {
  if (h.requestPermission) {
    const p = await h.requestPermission({ mode: "readwrite" });
    if (p !== "granted") throw new Error("write permission denied by user/browser");
  }
  const w = await h.createWritable();
  await w.write(blob);
  await w.close();
}

/** drop 事件里挑出第一个 .ora 的文件系统句柄。
 *  ⚠ DataTransferItemList 在事件处理器首个 await 之后失效——getAsFileSystemHandle 的调用
 *  必须**同步**发生；本函数同步收集全部 promise，await 留给返回值。不支持（Safari/Firefox）→ null。 */
export function droppedOraHandle(dt: DataTransfer | null): Promise<LocalFileHandle | null> {
  const promises: Promise<LocalFileHandle | null>[] = [];
  if (dt) {
    for (const it of dt.items) {
      const g = (it as unknown as { getAsFileSystemHandle?: () => Promise<LocalFileHandle> }).getAsFileSystemHandle;
      if (it.kind === "file" && typeof g === "function") {
        promises.push(g.call(it).catch(() => null));
      }
    }
  }
  return (async () => {
    for (const p of promises) {
      const h = await p;
      if (h && (h.kind ?? "file") === "file" && /\.ora$/i.test(h.name)) return h;
    }
    return null;
  })();
}

/** 安装态 PWA 的「双击 .ora 用 WeebPaint 打开」（manifest file_handlers）。浏览器缓存 launch 事件，
 *  boot 后再 setConsumer 也收得到。非安装态/不支持 → 静默 no-op。 */
export function consumeLaunchFiles(cb: (h: LocalFileHandle) => void): void {
  const lq = (globalThis as unknown as { launchQueue?: { setConsumer(f: (p: { files?: unknown[] }) => void): void } }).launchQueue;
  if (!lq) return;
  lq.setConsumer((p) => { for (const f of p.files ?? []) cb(f as LocalFileHandle); });
}

/** WeebPaint 痕迹检测（纯函数）：decode 出的 ora 带我们任一 sidecar/元数据 → 是 WeebPaint 写的 →
 *  可原位编辑。外来 ora（Krita 等）三样全无 → 走导入（绝不用我们的有损解读原位覆写别人的文件）。 */
export function hasWeebPaintTraces(loaded: { _weebpaintState?: unknown; _editorState?: unknown; _wroteWith?: unknown }): boolean {
  return loaded._weebpaintState != null || loaded._editorState != null || loaded._wroteWith != null;
}
