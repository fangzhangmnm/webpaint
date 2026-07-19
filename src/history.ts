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
//   2. handler shape 统一 { undo(e), redo(e), validate?(e), dispose?(e) }
//   3. entry data schema 一致（同类 op 用同一壳）
//   4. handler 之间不互相调

// 一条 undo entry：type 是 dispatch key，其余字段是 op 自带的最小 payload（领域无关，动态壳）。
// export：op 模块（pixel-edit / layer-undo / toolbar / input）push/registerHandler 时直接绑此契约，
//   省掉 `as unknown as Parameters<UndoStack["push"]>[0]` 那串占位 cast（v320 精度收口）。
import { reportError } from "./error-badge.ts";

export interface UndoEntry extends Record<string, unknown> {
  type: string;
}

// handler 统一 shape（见上文纪律 2）。entry 收 UndoEntry；undo/redo 可同步可异步。
export interface UndoHandler {
  undo(e: UndoEntry): void | Promise<void>;
  redo(e: UndoEntry): void | Promise<void>;
  // push 时校验 entry 契约：返回错误说明 = 这条 entry 跟本 handler 对不上（push 方写错了壳）。
  //   **不抛**——doc 已经改过了，抛只会把 doc 和 history 撕得更开；走 reportError("error") 红条。
  //   动机：UndoEntry 是 Record<string, unknown>，push 什么都能过 TS。曾经「清空图层」手搓的
  //   entry 把压缩结果写进 before.blob 而 handler 读 e.beforeBlob，编译期运行期都没人吭声，
  //   一直到用户按下 Ctrl+Z 才发现画没了。push 每次用户操作只跑一次，不在热路径，故常开。
  validate?(e: UndoEntry): string | null;
  // entry 被淘汰（超出 max / 被 redo 段截断 / clear）时释放它持有的重资源。
  dispose?(e: UndoEntry): void;
}

export class UndoStack {
  entries: UndoEntry[];
  index: number;
  max: number;
  handlers: Map<string, UndoHandler>;
  _busy = false;   // undo/redo 进行中（async handler 让出期间挡住第二次按键；见 undo()）

  constructor({ max = 50 }: { max?: number } = {}) {
    this.entries = [];
    this.index = -1;          // index of "currently applied" entry; -1 = nothing applied
    this.max = max;
    this.handlers = new Map();  // type → { undo, redo, validate?, dispose? }
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
    const why = this.handlers.get(entry.type)?.validate?.(entry);
    if (why) reportError(new Error(`[history] entry "${entry.type}" 不合契约：${why}（这一步将无法正确撤销）`), "error");
    this.entries.push(entry);
    this.index++;
    while (this.entries.length > this.max) {
      const evicted = this.entries.shift()!;
      this._dispose(evicted);
      this.index--;
    }
    this._emit();
  }

  // 游标**只在 handler 兑现之后**才移动。若 handler 抛了，doc 已处于半改状态，此时保持
  //   `entries[index] == 最后一条已应用` 这个不变量比"假装撤销成功了"重要得多——否则下一次
  //   undo 会跳过一条、doc 与 history 从此错位（本次 group 事故的第二重原因）。
  // 错误级别 "log"→"error"：撤销失败是数据完整性事件，必须弹红条。CLAUDE.md 里 "log" 是留给
  //   良性 offline/fallback 的，这不是。
  // _busy 闩：removeLayer/mergeDown/selectionToLayer 的 handler 是 async（await createImageBitmap
  //   会让出），连按两次 Ctrl+Z 会让两个半应用的 handler 交错改同一个 doc。丢弃第二次按键是对的；
  //   排队只是把同样的树形态危险往后推。canUndo() 不反映这个闩（按钮不闪，多余的按键静默忽略）。
  async undo() {
    if (this._busy || !this.canUndo()) return;
    this._busy = true;
    const i = this.index;
    const e = this.entries[i];
    const h = this.handlers.get(e.type);
    try {
      if (!h) { reportError(new Error(`[history] 没有 "${e.type}" 的 handler，这一步未能撤销`), "error"); return; }
      await h.undo(e);
      this.index = i - 1;
    } catch (err) {
      reportError(new Error(`[history] 撤销 "${e.type}" 失败，历史游标停在原位：` + String(err)), "error");
    } finally { this._busy = false; this._emit(); }
  }

  async redo() {
    if (this._busy || !this.canRedo()) return;
    this._busy = true;
    const i = this.index + 1;
    const e = this.entries[i];
    const h = this.handlers.get(e.type);
    try {
      if (!h) { reportError(new Error(`[history] 没有 "${e.type}" 的 handler，这一步未能重做`), "error"); return; }
      await h.redo(e);
      this.index = i;
    } catch (err) {
      reportError(new Error(`[history] 重做 "${e.type}" 失败，历史游标停在原位：` + String(err)), "error");
    } finally { this._busy = false; this._emit(); }
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
      try { h.dispose(entry); } catch (err) { reportError(new Error(`[history] dispose failed: ` + String(err)), "log"); }
    }
  }

  _emit() {
    // 沿用现有 wp:histchange event，UI 监听 canUndo/canRedo 自动更新
    window.dispatchEvent(new CustomEvent("wp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() },
    }));
  }
}
