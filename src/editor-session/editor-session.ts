// ⚠ 接本模块必读同目录 README.md + CONTEXT.md。家族共享深模块（与 sync-store 平级，互拷）。
//
// editor-session —— 一个 doc「从打开到关闭、保持同步」的生命周期编排者。**app-agnostic**：
//   自己不懂 paint/ora/canvas，只跟**不透明字节** + 注入的 editor 适配器 + policy 打交道。
//   它是 sync-store 的**消费者**（app 建 store，把 store 传进来；本模块不创建 store、不碰 provider/加密/ui）。
//
// 三层：app → editor-session → store。
//   · editor（app 的编辑引擎）：adopt(bytes) / encode()→bytes / onChange —— persistence-agnostic，不知有云。
//   · editor-session（本模块，共享）：打开/存/推/失焦 flush/退出推/崩溃恢复 的**通用编排**；autosave 策略注入。
//   · store（sync-store 库）：藏起同步的文件系统。app 建它（含 ui bundle），本模块只调 file/reconcile。
//
// 分层红线：
//   · **editor 绝不碰 store**（只经本模块的 adopt/encode）。
//   · **本模块只暴露 sync 无关的编辑生命周期**；冲突/错误/busy 是 store 的 ui bundle（app 建 store 时接），本模块不转发。
//   · autosave cadence / push 时机**每 app 不同 → policy 注入**（本模块只给机制 + 通用触发点）。

// ── 注入契约 ──────────────────────────────────────────────────────────────────────────────

/** app 的编辑引擎暴露给 editor-session 的最小面。本模块不懂内容，只调这几个。 */
export interface EditorAdapter {
  adopt(bytes: Blob): Promise<void>;    // 收字节 → 解码进编辑器（替换当前内容）。null/失败由 app 域处理。
  onChange(cb: () => void): void;       // 用户改动 → fire 一次（本模块据此标「内存脏」）。register-once。
  // 当前内容 → { bytes, peek }。peek = **content-blind 的不透明 sidecar 字节**（app 域自己决定语义，
  //   如画作缩略图/文本摘要；editor-session 不看、只把它作 store.save 的 hint 透传）。无则 peek 省略。
  encode(): Promise<{ bytes: Blob; peek?: Blob | null }>;
}

/** editor-session 消费的 store 最小面（结构类型；真 sync-store 天然满足，测试可 mock）。 */
// tryMove 结果（rename/move 唯一入口；含目标占用检查，占用则不动字节返错，不抛）。
export type TryMoveResult = { ok: true } | { ok: false; reason: "name-collision"; where: "local" | "cloud" };
export interface StoreLike {
  file(name: string, opts: { isZip: boolean }): {
    open(): Promise<Blob | null>;
    save(bytes: Blob, opts?: { tryPush?: boolean; hint?: unknown }): Promise<void>;
    delete(): Promise<void>;
  };
  tryMove(from: string, to: string): Promise<TryMoveResult>;   // 改身份/移动唯一入口（含 nameOccupied 占用检查）
  reconcile?(opts?: { activeName?: string }): Promise<void>;
}

/** app-agnostic 的 autosave / push 策略（每 app 不同 → 注入）。 */
export interface LifecyclePolicy {
  autosaveMs?: number;                           // 本地自动存间隔（0/缺 = 不自动，app 自己驱动 flushLocal）
  pushOn?: Array<"exit" | "blur" | "idle">;      // 何时 consent-push（WebPaint = ["exit"]）；缺 = 只 exit
  idleMs?: number;                               // pushOn 含 "idle" 时的空闲阈值（缺 = 不 idle-push）
}

export interface EditorSessionConfig {
  store: StoreLike;
  editor: EditorAdapter;
  isZip?: boolean;                               // 这个 app 的 doc 是不是 zip 容器（有 peek）。默认 false。
  policy?: LifecyclePolicy;
}

// ── 生命周期编排者 ────────────────────────────────────────────────────────────────────────

export interface EditorSession {
  open(name: string): Promise<boolean>;          // 打开 doc：先存旧 → file.open() → adopt。返回是否 adopt 了（false=文件缺失/锁定，未装入）
  adopted(name: string): void;                    // 编辑器内容已由 app 装入（new-doc/import，非 store.open）→ 记为当前 + 标脏
  markDirty(): void;                              // app 驱动的内容变化（不走 editor onChange，如设置/参考窗）→ 标脏
  markWorkspacePending(): void;                    // 标 workspace 脏（不标内存脏）→ 徽章静默，但 flushLocal+flushAndPush 都会 encode（落本地+退出推）。给 workspaceDirty（desk 变、非内容变）用
  flushLocal(): Promise<void>;                    // 立即存本地（不推）——内存脏才动
  flushAndPush(): Promise<void>;                  // 立即存本地 + best-effort 推云——内存脏 **或** push-pending 才动
  rename(newName: string): Promise<TryMoveResult>;   // 改身份（先 flush 旧内容）→ 走 store.tryMove；占用则返 {ok:false}（不改 _name）
  delete(): Promise<void>;                        // 删当前 doc
  currentName(): string | null;
  isDirty(): boolean;                             // **内存脏**（自上次落盘后 editor 改过）——app 层概念，非 sync 脏
  start(): void;                                  // 挂 autosave timer + 失焦/pagehide 监听（按 policy）；DOM 无则 no-op
  dispose(): void;                                // 拆监听 + 停 timer
}

export function createEditorSession(config: EditorSessionConfig): EditorSession {
  const { store, editor, isZip = false } = config;
  const policy = config.policy ?? {};
  const pushOn = new Set(policy.pushOn ?? ["exit"]);

  let _name: string | null = null;
  let _dirty = false;                              // 内存脏：editor 改过、还没落本地（驱动 autosave）
  let _pushPending = false;                        // 推-pending：自上次成功推后编辑过（驱动退出推；≠内存脏，flushLocal 清内存脏但留 push-pending）
  let _workspacePending = false;                   // workspace 脏（desk 改过、非内容）：徽章静默，但 flushLocal **和** flushAndPush 都要 encode 落盘（desk 跟画走）
  let _saving = false;                             // 落盘中（防重入/竞态）
  let _timer: ReturnType<typeof setInterval> | null = null;
  let _idleTimer: ReturnType<typeof setTimeout> | null = null;
  let _onChangeWired = false;

  // editor 改动 → 标内存脏（register-once；editor 生命周期 = 整个 app，无需解绑）。
  function wireOnChange(): void {
    if (_onChangeWired) return;
    _onChangeWired = true;
    editor.onChange(() => {
      _dirty = true; _pushPending = true;
      if (pushOn.has("idle")) scheduleIdle();
    });
  }

  const fileOf = (name: string) => store.file(name, { isZip });

  // tryPush=false（flushLocal/autosave）：内存脏才动。tryPush=true（flushAndPush/退出）：内存脏 **或** push-pending 就动
  //   （= autosave 已把内容落本地、内存不脏但还没推 → 退出仍要推，否则本次编辑只在本地）。
  async function persist(tryPush: boolean): Promise<void> {
    // workspacePending 进两侧 need：desk 改动（无像素编辑）也要落本地（flushLocal 崩溃安全）+ 退出/推时推云。
    const need = tryPush ? (_dirty || _pushPending || _workspacePending) : (_dirty || _workspacePending);
    if (!_name || !need || _saving) return;
    _saving = true;
    try {
      const { bytes, peek } = await editor.encode();
      _dirty = false;                              // 清内存脏：encode 已取快照；期间再改会重新置脏（下轮 autosave 收）
      _workspacePending = false;                   // encode 已把 editorState.Serialize() 快照进 meta（desk 已落）
      if (tryPush) _pushPending = false;           // 乐观清 push-pending（push 失败留 sync-dirty，store 内部 queue 补推）
      await fileOf(_name).save(bytes, { tryPush, hint: peek != null ? { peek } : undefined });
    } finally {
      _saving = false;
    }
  }

  function scheduleIdle(): void {
    if (!pushOn.has("idle") || !policy.idleMs) return;
    if (_idleTimer != null) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => { void persist(true); }, policy.idleMs);
  }

  return {
    currentName: () => _name,
    isDirty: () => _dirty,

    async open(name: string): Promise<boolean> {
      if (_name && _name !== name) await persist(pushOn.has("exit"));   // 切 doc 前先存旧的（退出语义）
      wireOnChange();
      const blob = await fileOf(name).open();      // open 内含 freshness / 冲突 surface（store 的 ui）/ 崩溃恢复
      if (blob) await editor.adopt(blob);
      _name = name;
      _dirty = false; _pushPending = false; _workspacePending = false;   // 刚 adopt = 干净（本会话未编辑；desk 由 Unserialize 载入，非 pending）
      return blob != null;                          // false = 文件缺失/锁定，doc 未装入（boot 据此回图库）
    },

    adopted(name: string): void {                  // new-doc/import：编辑器内容由 app 装入（非 store.open）→ 当前 + 脏
      wireOnChange();
      _name = name;
      _dirty = true; _pushPending = true; _workspacePending = false;   // 新内容未落盘/未推；desk=默认（reset 过）非 pending
    },

    markDirty(): void { _dirty = true; _pushPending = true; },   // app 驱动内容变化（onChange 之外）→ 标脏
    markWorkspacePending(): void { _workspacePending = true; },  // workspaceDirty：徽章不显脏，但 flushLocal+flushAndPush 都 encode（desk 落本地+退出推）

    flushLocal: () => persist(false),
    flushAndPush: () => persist(true),

    async rename(newName: string): Promise<TryMoveResult> {
      if (!_name) return { ok: true };
      await persist(false);                        // 先把内存落到旧名
      const r = await store.tryMove(_name, newName);   // 唯一入口（含占用检查）；占用→不改 _name
      if (r.ok) _name = newName;
      return r;
    },

    async delete(): Promise<void> {
      if (!_name) return;
      const n = _name;
      _name = null; _dirty = false; _pushPending = false; _workspacePending = false;
      await fileOf(n).delete();
    },

    start(): void {
      wireOnChange();
      if (policy.autosaveMs && policy.autosaveMs > 0) {
        if (_timer != null) clearInterval(_timer);
        _timer = setInterval(() => { void persist(false); }, policy.autosaveMs);   // autosave 只本地（consent-safe）
      }
      const doc = (globalThis as { document?: EventTarget }).document;
      const win = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener
        ? (globalThis as unknown as EventTarget) : null;
      // 崩溃安全：页面隐藏/卸载 → flushLocal（不推：页面要关，push 未必完成）。
      doc?.addEventListener?.("visibilitychange", () => {
        if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === "hidden") void persist(false);
      });
      win?.addEventListener?.("pagehide", () => { void persist(false); });
      // 失焦：按 policy 决定推不推。
      win?.addEventListener?.("blur", () => { void persist(pushOn.has("blur")); });
    },

    dispose(): void {
      if (_timer != null) { clearInterval(_timer); _timer = null; }
      if (_idleTimer != null) { clearTimeout(_idleTimer); _idleTimer = null; }
    },
  };
}
