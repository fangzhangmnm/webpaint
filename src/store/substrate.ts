// Substrate —— shape-agnostic 底座（L4，2026-06-07）。WorkFileStore 与 FolderStore 共享这一层。
// 只放「与 storage shape 无关、两个 facade 都要」的原语：byte utils + push-serialize + 编辑游标 + save 合流。
// **不**放 shape 语义 / 冲突策略 / etag·parentBase 权威——那些是 work-file 的 If-Match 机制，住 store.js（WorkFileFlow）。
// 见 CONTEXT.md「Store」段 L4 facade 定稿。
//
// TS 化（v223）：store 深模块被 Uint8Array/Blob 类型 bug 雷击两次 → 全面 .ts + tsc --noEmit strict。
// 这里定义贯穿全 store 的字节类型 Bytes。

// 落盘/上传的字节正规形态。toU8 把任意来源收敛到它。
export type Bytes = Uint8Array;
// toU8 可接受的来源（含 Blob —— 走 arrayBuffer 分支）。
export type BytesSource = Bytes | ArrayBuffer | Blob | string | null | undefined;

export async function toU8(x: BytesSource): Promise<Bytes> {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("Store: 无法识别的 bytes 类型");
}
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// save 合流的两种动作类型。
export type SaveType = "local" | "push";

// 编辑游标 facade。
export interface EditCursor {
  mark(): void;
  version(): number;
  markSaved(v?: number): void;
  localDirty(): boolean;
}

export interface Substrate {
  edits: EditCursor;
  session: Coalescer;
  serialize<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  serialize2<T>(a: string, b: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface Coalescer {
  configure(fns?: { doLocal?: () => Promise<void>; doPush?: () => Promise<void> }): void;
  request(type: SaveType): void;
  state(): { pending: SaveType | null; inFlight: SaveType | null; startVer: number };
}

export function createSubstrate(): Substrate {
  // ---- 编辑游标（④）：单一 SSoT。B2（work-file push）、本机合流（session）、本地落盘 dirty 共用同一游标。
  //   mark()        内容变了（任何 wp:histchange 或会进 .ora 的状态变更）→ 推进游标。
  //   markSaved()   本地落盘点：记下「已存进 IDB 的游标」。
  //   localDirty()  本地未落盘？= 游标自上次 markSaved 后又动过（取代 app 散落的 _docDirty 标志）。
  // cloud 未推是另一正交事实，走 cloud.isDirty（per-file、跨 reload 持久）；二者别混。
  let _editVersion = 0;
  let _savedVersion = 0;
  const edits: EditCursor = {
    mark: () => { _editVersion++; },
    version: () => _editVersion,
    markSaved: (v?: number) => { _savedVersion = (v == null) ? _editVersion : v; },
    localDirty: () => _editVersion !== _savedVersion,
  };

  // ---- push-serialize（B1）：同一 name 串行，每次等前一次跑完才启动。两个 shape 都要（撞同名写）。
  const _chain = new Map<string, Promise<void>>();
  function serialize<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = _chain.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    _chain.set(name, next.then(() => {}, () => {}));
    return next;
  }
  // 两个 name 各自链尾串行（rename 牵动两身份，须挡住对任一名的 in-flight 写）。
  function serialize2<T>(a: string, b: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = Promise.all([_chain.get(a) || Promise.resolve(), _chain.get(b) || Promise.resolve()]);
    const next = prev.then(fn, fn);
    const tail = next.then(() => {}, () => {});
    _chain.set(a, tail); _chain.set(b, tail);
    return next;
  }

  // ---- save 合流（④ coalescer）：连按 Ctrl+S/点保存不串 N 次。app 注入真·保存动作（configure）。
  //   - 没在跑 → 立刻跑
  //   - 在跑 + 期间没新编辑 + 同类型 → no-op（state 没变，省一次空转）
  //   - 在跑 + 期间有新编辑 → queue 尾巴，in-flight 完成后跑
  //   - 在跑 local-only + 用户改主意 push → queue push（云端还没覆盖）
  //   - pending 升级：push 盖过 local（再多按也只一个尾巴）
  // editVersion 取 edits 的 SSoT（与 work-file B2 同一个游标）。纯逻辑、无 I/O——可 node 单测（注入 fake doLocal/doPush）。
  function createCoalescer(): Coalescer {
    let pending: SaveType | null = null;
    let inFlight: SaveType | null = null;
    let startVer = 0;
    let doLocal = async () => {}, doPush = async () => {};
    function configure(fns: { doLocal?: () => Promise<void>; doPush?: () => Promise<void> } = {}) {
      if (fns.doLocal) doLocal = fns.doLocal;
      if (fns.doPush) doPush = fns.doPush;
    }
    async function _run(type: SaveType) {
      inFlight = type; startVer = _editVersion;
      try { if (type === "push") await doPush(); else await doLocal(); }
      finally {
        inFlight = null;
        if (pending) { const next = pending; pending = null; _run(next); }   // 不 await，避免递归栈
      }
    }
    function request(type: SaveType) {
      if (!inFlight) { _run(type); return; }
      const hasNewEdits = _editVersion !== startVer;
      const shouldQueue = (inFlight === "local" && type === "push") ? true : hasNewEdits;
      if (!shouldQueue) return;
      if (type === "push" || pending !== "push") pending = type;
    }
    return { configure, request, state: () => ({ pending, inFlight, startVer }) };
  }
  const session = createCoalescer();

  return { edits, session, serialize, serialize2 };
}
