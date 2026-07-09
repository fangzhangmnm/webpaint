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
  encode(): Promise<Blob>;              // 当前内容 → 字节（本模块拿去 store.save）。
  onChange(cb: () => void): void;       // 用户改动 → fire 一次（本模块据此标「内存脏」）。register-once。
  thumb?(): Promise<Blob | null>;       // 选填：当前内容缩略图 → 作 store.save 的 hint.thumb（content-blind 透传）。
}

/** editor-session 消费的 store 最小面（结构类型；真 sync-store 天然满足，测试可 mock）。 */
export interface StoreLike {
  file(name: string, opts: { isZip: boolean }): {
    open(): Promise<Blob | null>;
    save(bytes: Blob, opts?: { tryPush?: boolean; hint?: unknown }): Promise<void>;
    rename(newName: string): Promise<void>;
    delete(): Promise<void>;
  };
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
  open(name: string): Promise<void>;             // 打开 doc：先存旧的 → file(name).open() → editor.adopt()
  flushLocal(): Promise<void>;                    // 立即存本地（不推）——内存脏才动
  flushAndPush(): Promise<void>;                  // 立即存本地 + best-effort 推云——内存脏才动
  rename(newName: string): Promise<void>;         // 改身份（先 flush 旧内容）
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
  let _dirty = false;                              // 内存脏：editor 改过、还没落盘
  let _saving = false;                             // 落盘中（防重入/竞态）
  let _timer: ReturnType<typeof setInterval> | null = null;
  let _idleTimer: ReturnType<typeof setTimeout> | null = null;
  let _onChangeWired = false;

  // editor 改动 → 标内存脏（register-once；editor 生命周期 = 整个 app，无需解绑）。
  function wireOnChange(): void {
    if (_onChangeWired) return;
    _onChangeWired = true;
    editor.onChange(() => {
      _dirty = true;
      if (pushOn.has("idle")) scheduleIdle();
    });
  }

  const fileOf = (name: string) => store.file(name, { isZip });

  async function persist(tryPush: boolean): Promise<void> {
    if (!_name || !_dirty || _saving) return;
    _saving = true;
    try {
      const bytes = await editor.encode();
      const hint = editor.thumb ? { thumb: await editor.thumb() } : undefined;
      _dirty = false;                              // 先清脏：encode 已取快照；期间再改会重新置脏（下轮 autosave 收）
      await fileOf(_name).save(bytes, { tryPush, hint });
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

    async open(name: string): Promise<void> {
      if (_name && _name !== name) await persist(pushOn.has("exit"));   // 切 doc 前先存旧的（退出语义）
      wireOnChange();
      const blob = await fileOf(name).open();      // open 内含 freshness / 冲突 surface（store 的 ui）/ 崩溃恢复
      if (blob) await editor.adopt(blob);
      _name = name;
      _dirty = false;                              // 刚 adopt = 干净
    },

    flushLocal: () => persist(false),
    flushAndPush: () => persist(true),

    async rename(newName: string): Promise<void> {
      if (!_name) return;
      await persist(false);                        // 先把内存落到旧名
      await fileOf(_name).rename(newName);
      _name = newName;
    },

    async delete(): Promise<void> {
      if (!_name) return;
      const n = _name;
      _name = null; _dirty = false;
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
