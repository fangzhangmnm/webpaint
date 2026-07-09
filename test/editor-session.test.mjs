// editor-session 生命周期编排验收（mock store + mock editor，纯逻辑）。
//   验：open→adopt / onChange→内存脏 / flushLocal 不推 / flushAndPush 推 / 切 doc 前存旧 / rename 先 flush /
//       不脏 no-op / encode 快照后清脏 / hint.peek 透传 / delete 清态。
import { describe, it, assert, eq } from "./runner.mjs";
import { createEditorSession } from "../src/editor-session/index.ts";

// mock store：记录每次 save 的 {name, tryPush, hint}；file.open 返回预置 blob。
function mockStore() {
  const saves = [];
  const renames = [];
  const deletes = [];
  const opened = [];
  return {
    saves, renames, deletes, opened,
    _openReturns: new Blob(["CLOUD-OR-LOCAL"]),
    file(name, opts) {
      return {
        open: async () => { opened.push({ name, isZip: opts.isZip }); return this._openReturns; },
        save: async (bytes, o) => { saves.push({ name, tryPush: o?.tryPush, hint: o?.hint, size: bytes.size }); },
        rename: async (nn) => { renames.push({ from: name, to: nn }); },
        delete: async () => { deletes.push(name); },
      };
    },
  };
}

// mock editor：encode 返回带内容的 blob；onChange 存 cb 供测试触发；adopt 记录。
function mockEditor() {
  let changeCb = () => {};
  const adopted = [];
  let encodeCount = 0;
  return {
    adopted, get encodeCount() { return encodeCount; },
    fireChange: () => changeCb(),
    adopt: async (blob) => { adopted.push(blob); },
    encode: async () => { encodeCount++; return { bytes: new Blob(["DOC-BYTES-" + encodeCount]), peek: new Blob(["PEEK"]) }; },
    onChange: (cb) => { changeCb = cb; },
  };
}

describe("editor-session › 打开 & 内存脏", () => {
  it("open → file.open → editor.adopt；开完不脏", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor, isZip: true });
    await es.open("a.ora");
    eq(store.opened.length, 1); eq(store.opened[0].isZip, true);
    eq(editor.adopted.length, 1, "adopt 收到 open 的 blob");
    eq(es.currentName(), "a.ora"); eq(es.isDirty(), false);
  });
  it("editor onChange → 内存脏", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    eq(es.isDirty(), true);
  });
});

describe("editor-session › flush 本地 vs 推云", () => {
  it("flushLocal → save({tryPush:false})；清脏", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    await es.flushLocal();
    eq(store.saves.length, 1); eq(store.saves[0].tryPush, false); eq(es.isDirty(), false);
  });
  it("flushAndPush → save({tryPush:true})", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    await es.flushAndPush();
    eq(store.saves[0].tryPush, true);
  });
  it("不脏 → flush no-op（不 encode 不 save）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a");                     // 开完不脏
    await es.flushLocal(); await es.flushAndPush();
    eq(store.saves.length, 0, "不脏不存"); eq(editor.encodeCount, 0, "不脏不 encode");
  });
  it("hint.peek 透传给 store.save", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange(); await es.flushLocal();
    assert(store.saves[0].hint && store.saves[0].hint.peek instanceof Blob, "hint.peek 应为 Blob");
  });
});

describe("editor-session › 切 doc / rename / delete", () => {
  it("切 doc 前先存旧的（pushOn 默认 exit → tryPush:true）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });   // policy 缺 → pushOn=["exit"]
    await es.open("a"); editor.fireChange();
    await es.open("b");                                    // 切到 b：应先存 a（推）
    eq(store.saves.length, 1); eq(store.saves[0].name, "a"); eq(store.saves[0].tryPush, true, "切走=exit 语义→推");
    eq(es.currentName(), "b"); eq(editor.adopted.length, 2);
  });
  it("切 doc 时旧的不脏 → 不存", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); await es.open("b");
    eq(store.saves.length, 0);
  });
  it("rename → 先 flush 旧内容再改名", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    await es.rename("b");
    eq(store.saves.length, 1); eq(store.saves[0].name, "a"); eq(store.saves[0].tryPush, false, "rename 先本地 flush");
    eq(store.renames[0].from, "a"); eq(store.renames[0].to, "b");
    eq(es.currentName(), "b");
  });
  it("delete → file.delete + 清当前", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); await es.delete();
    eq(store.deletes[0], "a"); eq(es.currentName(), null);
  });
});

describe("editor-session › policy: blur 推 vs 不推", () => {
  it("pushOn 含 blur → 切 doc 前存旧仍按 exit（open 用 exit 语义）", async () => {
    // open 切 doc 用 exit 语义；此测确认 pushOn 集合正确解析（exit 默认存在）
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor, policy: { pushOn: ["blur"] } });   // 无 exit
    await es.open("a"); editor.fireChange(); await es.open("b");
    eq(store.saves[0].tryPush, false, "policy 无 exit → 切 doc 存旧只本地不推");
  });
});

describe("editor-session › push-pending（autosave 后退出仍推）", () => {
  it("flushLocal 后 flushAndPush 仍推（内存不脏但 push-pending）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    await es.flushLocal();                    // 存本地：内存脏清、push-pending 留
    eq(es.isDirty(), false);
    await es.flushAndPush();                  // 内存不脏，但 push-pending → 应推
    eq(store.saves.length, 2); eq(store.saves[1].tryPush, true, "autosave 过的内容退出仍推");
  });
  it("flushAndPush 后再 flushAndPush no-op（无新编辑）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a"); editor.fireChange();
    await es.flushAndPush(); await es.flushAndPush();
    eq(store.saves.length, 1, "推过且无新编辑 → 第二次 no-op");
  });
  it("adopted（new-doc）→ 内存脏+push-pending", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    es.adopted("new.ora");
    eq(es.currentName(), "new.ora"); eq(es.isDirty(), true);
    await es.flushLocal(); eq(store.saves[0].name, "new.ora"); eq(store.saves[0].tryPush, false);
  });
});
