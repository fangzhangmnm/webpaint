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
  // 可选：某身份的字节**成功落盘**后 fire（本地写成即算；push 与否不影响）。app 域用来作废派生缓存
  //   （如画作缩略图）。本模块仍 content-blind——只报「name 的字节变了」，不知道变了什么。
  onSaved?(name: string): void;
}

/** editor-session 消费的 store 最小面（结构类型；真 sync-store 天然满足，测试可 mock）。 */
// tryMove 结果（rename/move 唯一入口；含目标占用检查，占用则不动字节返错，不抛）。
//   ok:true 仍可能有话要说 —— 旧名的去向不是只有「搬走了」一种：
//   oldKept=谱系不明，改名降级为另存、旧名原地留着 · oldCloudOrphan=旧名没能挪进回收站 · cloudDeferred=云端没推成。
export type TryMoveResult =
  | { ok: true; where?: string; oldName?: string; oldKept?: boolean; oldUnknown?: boolean; oldCloudOrphan?: boolean; cloudDeferred?: boolean }
  | { ok: false; reason: "name-collision"; where: "local" | "cloud" };
export interface StoreLike {
  // mode 显式必填（new=新建、existing=打开已有）；editor-session 处理的都是已建身份 → 恒 "existing"。
  file(name: string, opts: { isZip: boolean; mode: "new" | "existing" }): {
    open(): Promise<Blob | null>;
    // pushed=false 不是错误，是事实（离线/冲突未解决/只落本地）→ 据此保住 push-pending，别乐观清。
    save(bytes: Blob, opts?: { tryPush?: boolean; hint?: unknown }): Promise<{ pushed: boolean; reason?: string }>;
    tryMove(to: string): Promise<TryMoveResult>;   // 改身份/移动唯一入口（含 nameOccupied 占用检查）——挂在 file 上
    delete(): Promise<{ status: string }>;   // status 不是「成功」的同义词（cancelled/noop 也走这里）
  };
}

/** app-agnostic 的 autosave / push 策略（每 app 不同 → 注入）。 */
export interface LifecyclePolicy {
  autosaveMs?: number;                           // 本地自动存间隔（0/缺 = 不自动，app 自己驱动 flushLocal）
  pushOn?: Array<"exit" | "blur" | "idle">;      // 何时 consent-push（WeebPaint = ["exit"]）；缺 = 只 exit
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
  adopted(name: string, opts?: { create?: boolean }): void;   // 编辑器内容已由 app 装入（new-doc/import，非 store.open）→ 记为当前 + 标脏；{create:true}=首存 mode:"new"（撞名不覆盖）
  markDirty(): void;                              // app 驱动的内容变化（不走 editor onChange，如设置/参考窗）→ 标脏
  flushLocal(): Promise<void>;                    // 立即存本地（不推）——内存脏才动
  flushAndPush(): Promise<void>;                  // 立即存本地 + best-effort 推云——内存脏 **或** push-pending 才动（退出用）
  forceSaveAndPush(): Promise<void>;              // **无条件** encode + 存 + 推（用户显式按 save）——不脏也要动，让时间戳走字（v409）
  rename(newName: string): Promise<TryMoveResult>;   // 改身份（先 flush 旧内容）→ 走 file.tryMove；占用则返 {ok:false}（不改 _name）
  delete(): Promise<void>;                        // 删当前 doc
  currentName(): string | null;
  isDirty(): boolean;                             // **内存脏**（自上次落盘后 editor 改过）——app 层概念，非 sync 脏
  // **未上云**：字节已落本地，但云端那条腿没成（离线 / 冲突面选了取消 / deferred 落地未确认）。
  //   与 isDirty 正交：isDirty=false ∧ isPushPending=true 是最要命的组合——「存过了」但「没上云」，
  //   而 v432 之前它没有任何渲染面，于是徽章照画云朵对勾（用户报的「远端文件不一样而 UI 从没说过」）。
  isPushPending(): boolean;
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

  const fileOf = (name: string) => store.file(name, { isZip, mode: "existing" });   // open/rename/删：已建身份
  // adopted({create:true})（新建画布/import）→ 该身份的**首存**用 mode:"new"（撞名不覆盖），首存成功即转 existing。
  // ⚠ **per-name，不是会话级布尔**（v417 修）：旧版是 `let _createNext = false`，只在 save() **resolve** 后
  //   才复位，且 open() 从不复位它。于是任意一次 save 抛异常（比如导入一个重名 .ora）就把它永久钉在 true
  //   直到关标签页——之后**每个文件的每次保存**都走 mode:"new" → create-store 的 nameOccupied 先查本地 →
  //   刚打开的文件本地当然有 → 抛 CloudNameCollisionError（文案还说"云端同名"）。自我延续：让 flag 卡住的
  //   那个抛错，本身就是 flag 造成的。绑到具体身份上，跨文档泄漏就不可表示了。
  let _createFor: string | null = null;

  // tryPush=false（flushLocal/autosave）：内存脏才动。tryPush=true（flushAndPush/**退出**）：内存脏 **或** push-pending 就动
  //   （= autosave 已把内容落本地、内存不脏但还没推 → 退出仍要推，否则本次编辑只在本地）。
  // force=true（forceSaveAndPush/**用户显式按 save**）：跳过 need 门，不脏也 encode+推（v409：时间戳必须走字，
  //   否则用户点了 save 看到时间戳没动会以为坏了）。desk 改动**不进** need —— 只在顺路落盘时被 encode 顺手捞走
  //   （v409 决策：退出只有 contentDirty 才推，desk 可抛；详 editor-state.ts 的 ⚠ 段）。
  async function persist(tryPush: boolean, force = false): Promise<void> {
    const need = force || (tryPush ? (_dirty || _pushPending) : _dirty);
    if (!_name || !need || _saving) return;
    _saving = true;
    // ★ 失败回滚用（v417）：下面会**先**乐观清脏、**再** await save()。save() 抛异常时若不还原，
    //   本次编辑就在内存里被宣布"已落盘"而实际一个字节都没写 —— badge 画干净、autosave 看 need=false
    //   永不重试、退出时那个专为保存失败设计的「重试/丢弃」循环（session-state 的 while (es.isDirty())）
    //   也被一并解除武装。那是 K2 红线（绝不无条件宣布干净）破在执行它的模块下面一层。
    const wasDirty = _dirty, wasPushPending = _pushPending;
    try {
      const { bytes, peek } = await editor.encode();
      _dirty = false;                              // 清内存脏：encode 已取快照；期间再改会重新置脏（下轮 autosave 收）
      // 新建画布/import 首存 → mode:"new"（撞名不静默覆盖，抛 CloudNameCollisionError；saveNow 已 try/catch surface）；成功即转 existing（后续 autosave = 编辑）。
      const mode = _createFor === _name ? "new" : "existing";
      const res = await store.file(_name, { isZip, mode }).save(bytes, { tryPush, hint: peek != null ? { peek } : undefined });
      // push-pending 按**实际结果**清，不再乐观清（v432）。旧版在 save 之前就 `_pushPending = false`，
      //   而 store 内部把 push 失败 catch 成 banner 后 save() 照常 resolve → 这里永远看不到失败 →
      //   badge 画干净、退出不再重推、下次 autosave 也不补 → 云端始终停在旧版而 UI 从没说过失败。
      //   （旧注释说"store 内部 queue 补推"是假保证：WeebPaint 用默认 "manual" 策略，upload-queue 第一行就返回，
      //    那个队列永不 drain。）
      //   `res?.pushed !== true` 而非 `!res.pushed`：store 没报告结果（旧适配器/mock）时**假定没推上去**，
      //   保住 push-pending 下次重试。宁可多推一次，也不要静默清干净（优先级②）。
      if (tryPush) _pushPending = res?.pushed !== true;
      if (_createFor === _name) _createFor = null;   // 首存成功 → 这个身份已建，后续都是编辑
      // 落盘成功 → 通知 app 域字节变了（缩略图等派生缓存作废）。save() 能 resolve = 本地已写成
      //   （push 失败被 store 内部 catch 成 banner，不影响「字节已变」这个事实）。
      if (_name != null) editor.onSaved?.(_name);
    } catch (e) {
      // 还原**入场时的真实状态**（不是无脑置脏）：本来脏就继续脏（工作没丢、重试武装着）；
      //   本来干净（force save 一个未改动的 doc）就保持干净，别造一个假的脏 badge。
      //   store.save() 内部已吞掉 push 失败（只 reportError），所以能抛到这里的基本都是"本地也没写成"。
      _dirty = wasDirty; _pushPending = wasPushPending;
      throw e;
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
    isPushPending: () => _pushPending,

    async open(name: string): Promise<boolean> {
      if (_name && _name !== name) await persist(pushOn.has("exit"));   // 切 doc 前先存旧的（退出语义）
      wireOnChange();
      const blob = await fileOf(name).open();      // open 内含 freshness / 冲突 surface（store 的 ui）/ 崩溃恢复
      // ★ 开一个身份是**事务性**的：没真的装入字节，会话就绝不指向它（v417 修，优先级 1 = OneDrive 不丢画）。
      //   旧版无条件 `_name = name`，于是 blob==null（离线纯云端 / 文件锁定 / 本地字节没了）时：
      //     · 画布上还是**上一张画**，身份却已经换成新名字 → 下次 autosave 把上一张画的像素写进新身份
      //       → 退出时 pushOn:["exit"] 推上 OneDrive，覆盖掉目标那张画。
      //     · boot 失败路径更隐蔽：boot.ts 的 session.setName(null) 只清 app 层的 _activeSessionName，
      //       es._name 还留着 X.ora → 用户在空白画布上画一笔 → autosave 把空白覆盖到 X.ora。
      //   `session.ts:48-52` 记着 AtlasMaker 0.7.2 就是这么吃掉一个加密文件的：**app 层的幽灵路径守卫
      //   本身是对的**，它是被这里私留的第二份名字绕过去的。
      //   失败时**保持原有 _name/_dirty 不动**（不是清成 null）：画布上仍是旧文档，它就该继续存回自己的身份。
      if (!blob) return false;                     // false = 文件缺失/锁定，doc 未装入（caller 据此回图库、别改活动名）
      await editor.adopt(blob);
      _name = name;
      _dirty = false; _pushPending = false;        // 刚 adopt = 干净（本会话未编辑；desk 由 Unserialize 载入）
      if (_createFor === name) _createFor = null;  // 这个名字已能从 store 打开 → 身份已建，不该再走 mode:"new"
      return true;
    },

    adopted(name: string, opts?: { create?: boolean }): void {   // new-doc/import：编辑器内容由 app 装入（非 store.open）→ 当前 + 脏
      wireOnChange();
      _name = name;
      _dirty = true; _pushPending = true;          // 新内容未落盘/未推；desk=默认（reset 过）
      _createFor = opts?.create ? name : null;     // 新建画布/import → **该身份**首存 mode:"new"（撞名不覆盖）；纯 adopt(revert/切名) 不设 = existing
    },

    markDirty(): void { _dirty = true; _pushPending = true; },   // app 驱动内容变化（onChange 之外）→ 标脏

    flushLocal: () => persist(false),
    flushAndPush: () => persist(true),
    forceSaveAndPush: () => persist(true, true),   // 用户显式按 save：无条件 encode+推（v409）

    async rename(newName: string): Promise<TryMoveResult> {
      if (!_name) return { ok: true };
      await persist(false);                        // 先把内存落到旧名
      const r = await fileOf(_name).tryMove(newName);   // 唯一入口（含占用检查，挂在 file 上）；占用→不改 _name
      if (r.ok) _name = newName;
      return r;
    },

    async delete(): Promise<void> {
      if (!_name) return;
      const n = _name;
      _name = null; _dirty = false; _pushPending = false;
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
