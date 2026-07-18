// editor-session **数据安全**回归（v417 止血批）。这一整个文件都是"曾经真的会丢画/丢工作"的路径。
//
// 判据（用户 2026-07-18 拍定的词典序优先级，不是加权）：
//   **OneDrive 不丢画 >> 用户当前操作不丢 > 自愈**
// 每个 it() 下面都标了它守的是哪一级。断言按这个排序写——注意 null-base 那组**不**断言"保存必须成功"。
import { describe, it, assert, eq } from "./runner.mjs";
import { createEditorSession } from "../src/editor-session/index.ts";

// mock store：可控 open 返回值 + 可控 save 抛错（模拟撞名护栏 / 本地写失败）。
function mockStore() {
  const saves = [];
  const opened = [];
  return {
    saves, opened,
    _openReturns: new Blob(["DOC"]),
    _saveThrows: null,        // 设成 Error 实例 → 下一次 save 抛它
    _saveThrowsOnce: false,
    file(name, opts) {
      const st = this;
      return {
        open: async () => { opened.push({ name, mode: opts.mode }); return st._openReturns; },
        save: async (bytes, o) => {
          if (st._saveThrows) {
            const e = st._saveThrows;
            if (st._saveThrowsOnce) { st._saveThrows = null; st._saveThrowsOnce = false; }
            throw e;
          }
          saves.push({ name, mode: opts.mode, tryPush: o?.tryPush });
        },
        tryMove: async () => ({ ok: true }),
        delete: async () => {},
      };
    },
  };
}
function mockEditor() {
  let changeCb = () => {};
  const adopted = [];
  return {
    adopted,
    fireChange: () => changeCb(),
    adopt: async (blob) => { adopted.push(blob); },
    encode: async () => ({ bytes: new Blob(["BYTES"]), peek: null }),
    onChange: (cb) => { changeCb = cb; },
  };
}

describe("editor-session › 开一个身份是事务性的（优先级 1：OneDrive 不丢画）", () => {
  it("open 失败（store 返 null）→ 会话**不**指向那个身份，adopt 也没发生", async () => {
    const store = mockStore(), editor = mockEditor();
    store._openReturns = null;                      // 离线纯云端 / 文件锁定 / 本地字节没了
    const es = createEditorSession({ store, editor });
    const ok = await es.open("missing.ora");
    eq(ok, false, "open 必须诚实返回 false");
    eq(editor.adopted.length, 0, "没字节就不该 adopt");
    eq(es.currentName(), null, "★ 绝不能指向一个没装进来的身份");
  });

  it("open 失败后画一笔再 autosave → **一个字节都不写**（旧版会把空白盖到 X.ora）", async () => {
    const store = mockStore(), editor = mockEditor();
    store._openReturns = null;
    const es = createEditorSession({ store, editor });
    await es.open("X.ora");
    editor.fireChange();                            // 用户在空白画布上画了一笔
    await es.flushLocal();
    eq(store.saves.length, 0, "★ boot 恢复失败后的涂鸦绝不能覆盖 X.ora");
  });

  it("已开着 A 时 open B 失败 → 仍持有 A，后续保存写回 A（不写 B）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("A.ora");                         // A 正常打开
    editor.fireChange();
    store._openReturns = null;                      // B 打不开
    const ok = await es.open("B.ora");
    eq(ok, false);
    eq(es.currentName(), "A.ora", "★ 画布上还是 A，身份就该还是 A");
    await es.flushLocal();
    const written = store.saves.filter((s) => s.name === "B.ora");
    eq(written.length, 0, "★ A 的像素绝不能写进 B 的身份");
  });
});

describe("editor-session › 保存失败不得宣布干净（优先级 2：用户当前操作不丢）", () => {
  it("save 抛错 → isDirty 仍为 true（退出重试环靠它武装）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a.ora");
    editor.fireChange();
    eq(es.isDirty(), true);
    store._saveThrows = new Error("撞名护栏 / 本地写失败");
    let threw = false;
    try { await es.flushLocal(); } catch { threw = true; }
    eq(threw, true, "失败必须抛给调用方 surface");
    eq(es.isDirty(), true, "★ 保存没成功就不许说干净");
  });

  it("save 抛错后重试成功 → 正常落盘（脏标记没被吃掉）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a.ora");
    editor.fireChange();
    store._saveThrows = new Error("瞬态失败"); store._saveThrowsOnce = true;
    try { await es.flushLocal(); } catch { /* 预期 */ }
    await es.flushLocal();                          // 重试：need 门必须还是 true
    eq(store.saves.length, 1, "★ 重试要真的写进去");
    eq(es.isDirty(), false, "成功后才允许清脏");
  });

  it("force save 一个不脏的 doc 失败 → 不制造假的脏 badge（还原入场态，不是无脑置脏）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    await es.open("a.ora");
    eq(es.isDirty(), false);
    store._saveThrows = new Error("推失败");
    try { await es.forceSaveAndPush(); } catch { /* 预期 */ }
    eq(es.isDirty(), false, "本来就干净（内容==盘上）→ 失败后仍该是干净");
  });
});

describe("editor-session › create 标记是 per-name，不会跨文档泄漏（优先级 2）", () => {
  it("新建首存失败 → 不把 mode:\"new\" 传染给之后打开的别的文件", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    es.adopted("imported.ora", { create: true });   // 导入 → 首存应走 mode:"new"
    store._saveThrows = new Error("CloudNameCollisionError"); store._saveThrowsOnce = true;
    try { await es.flushLocal(); } catch { /* 预期：重名导入 */ }

    // 旧版这里 _createNext 被永久钉在 true → 之后每个文件的每次保存都走 mode:"new" → 撞本地副本 → 全线保存失败。
    // 注意 open() 会先把还脏的 imported.ora 落盘（脏标记在失败后被正确还原了，见上一组）——
    //   那次重试**仍该是 new**（imported.ora 这个身份确实还没建起来），而新开的文件**必须是 existing**。
    //   两者同时成立，正是"per-name 而非会话级"的意思。
    await es.open("existing.ora");
    editor.fireChange();
    await es.flushLocal();

    const retry = store.saves.filter((s) => s.name === "imported.ora");
    eq(retry.length, 1, "切 doc 前把失败的那次重试掉了（工作没丢）");
    eq(retry[0].mode, "new", "imported.ora 身份仍未建 → 重试仍走首存护栏");

    const other = store.saves.filter((s) => s.name === "existing.ora");
    eq(other.length, 1);
    eq(other[0].mode, "existing", "★ 打开的已有文件必须走 existing，不能被上一次失败传染成 new");
  });

  it("新建首存成功 → 该身份转 existing（后续 autosave 是编辑不是新建）", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    es.adopted("fresh.ora", { create: true });
    await es.flushLocal();
    eq(store.saves[0].mode, "new", "首存 = new（撞名不静默覆盖）");
    editor.fireChange();
    await es.flushLocal();
    eq(store.saves[1].mode, "existing", "第二次起 = existing");
  });

  it("open 一个正待新建的同名身份 → 该身份已存在，转 existing", async () => {
    const store = mockStore(), editor = mockEditor();
    const es = createEditorSession({ store, editor });
    es.adopted("dup.ora", { create: true });
    await es.open("dup.ora");                        // 它能从 store 打开 = 已经建好了
    editor.fireChange();
    await es.flushLocal();
    eq(store.saves[0].mode, "existing", "★ 能打开就说明身份已建，别再走首存护栏");
  });
});
