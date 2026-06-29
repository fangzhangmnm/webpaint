// Undo / Redo 通用栈。Command pattern + 注册式 handler（"α 形态"）。
//
// 设计原则在 docs/20260527-undo-architecture.md。给下个 AI / AtlasMaker 兄弟看：
//
// - **不抄 Blender memfile**（整状态 snapshot 慢 + 内存大）
// - 取 Procreate / Photoshop / Krita pattern：每个 op 只存自己变了的最小数据
// - history.js 是**领域无关**的栈，不知道 layer / brush 概念
// - 各领域（input、layer panel）注册自己的 handler dispatch
//
// 四条纪律（α → β 升级路径用）：
//   1. handler 注册集中（boot 时段，grep registerHandler 见全集）
//   2. handler shape 统一 { undo(e), redo(e), refsLayer?(e, id) }
//   3. entry data schema 一致（同类 op 用同一壳）
//   4. handler 之间不互相调

// 一条 undo entry：type 是 dispatch key，其余字段是 op 自带的最小 payload（领域无关，动态壳）。
// export：op 模块（pixel-edit / layer-undo / toolbar / input）push/registerHandler 时直接绑此契约，
//   省掉 `as unknown as Parameters<UndoStack["push"]>[0]` 那串占位 cast（v320 精度收口）。
export interface UndoEntry extends Record<string, unknown> {
  type: string;
}

// handler 统一 shape（见上文纪律 2）。entry 收 UndoEntry；undo/redo 可同步可异步。
export interface UndoHandler {
  undo(e: UndoEntry): void | Promise<void>;
  redo(e: UndoEntry): void | Promise<void>;
  refsLayer?(e: UndoEntry, id: number): boolean;   // layer id 全程是 number
  dispose?(e: UndoEntry): void;
}

export class UndoStack {
  entries: UndoEntry[];
  index: number;
  max: number;
  handlers: Map<string, UndoHandler>;

  constructor({ max = 50 }: { max?: number } = {}) {
    this.entries = [];
    this.index = -1;          // index of "currently applied" entry; -1 = nothing applied
    this.max = max;
    this.handlers = new Map();  // type → { undo, redo, refsLayer?, dispose? }
  }

  registerHandler(type: string, handler: UndoHandler) {
    if (!handler || typeof handler.undo !== "function" || typeof handler.redo !== "function") {
      throw new Error(`UndoStack handler for "${type}" must have undo + redo`);
    }
    this.handlers.set(type, handler);
  }

  canUndo() { return this.index >= 0; }
  canRedo() { return this.index < this.entries.length - 1; }

  // 把一条新 entry 入栈（也代表"已经发生过"——push 前 caller 已经把效果应用到 doc 了）。
  // truncate redo segment（如果之前 undo 过然后又有新动作）。dispose 被裁掉的 entry。
  push(entry: UndoEntry) {
    if (!entry || typeof entry.type !== "string") {
      throw new Error("UndoStack.push: entry must have type:string");
    }
    if (this.index < this.entries.length - 1) {
      const dropped = this.entries.splice(this.index + 1);
      for (const e of dropped) this._dispose(e);
    }
    this.entries.push(entry);
    this.index++;
    while (this.entries.length > this.max) {
      const evicted = this.entries.shift()!;
      this._dispose(evicted);
      this.index--;
    }
    this._emit();
  }

  async undo() {
    if (!this.canUndo()) return;
    const e = this.entries[this.index];
    this.index--;
    const h = this.handlers.get(e.type);
    if (h) {
      try { await h.undo(e); }
      catch (err) { console.warn(`[history] undo handler "${e.type}" failed:`, err); }
    } else {
      console.warn(`[history] no handler for "${e.type}"`);
    }
    this._emit();
  }

  async redo() {
    if (!this.canRedo()) return;
    this.index++;
    const e = this.entries[this.index];
    const h = this.handlers.get(e.type);
    if (h) {
      try { await h.redo(e); }
      catch (err) { console.warn(`[history] redo handler "${e.type}" failed:`, err); }
    } else {
      console.warn(`[history] no handler for "${e.type}"`);
    }
    this._emit();
  }

  clear() {
    for (const e of this.entries) this._dispose(e);
    this.entries.length = 0;
    this.index = -1;
    this._emit();
  }

  _dispose(entry: UndoEntry) {
    const h = this.handlers.get(entry.type);
    if (h && typeof h.dispose === "function") {
      try { h.dispose(entry); } catch (err) { console.warn(`[history] dispose failed:`, err); }
    }
  }

  _emit() {
    // 沿用现有 wp:histchange event，UI 监听 canUndo/canRedo 自动更新
    window.dispatchEvent(new CustomEvent("wp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() },
    }));
  }
}
