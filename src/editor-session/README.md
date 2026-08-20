# editor-session —— 编辑器 doc 生命周期编排（家族共享深模块）

> 与 sync-store 平级的共享库，各编辑器 app 间**互拷代码**（WeebPaint / WebXiaoHeiWu / …）。本 README 随模块一起拷，是权威。

一个 doc「从打开到关闭、保持同步」的编排者。**app-agnostic**：不懂 paint/ora/canvas，只跟不透明字节 + 注入的适配器打交道。

## 三层

```
app  ──建──> store (sync-store)          app 建 store（含 provider/加密/ui bundle）
 │
 ├──给 editor 适配器 + policy──> editor-session ──消费──> store
 │                                    │
 └──editor（画图引擎）<──adopt/encode── editor-session
```

- **editor（app 的引擎）**：`adopt(bytes)` / `encode()→{bytes,peek}` / `onChange(cb)`。**persistence-agnostic**，不知有云。
- **editor-session（本模块）**：打开 / 存 / 推 / 失焦 flush / 退出推 / 崩溃恢复 的**通用编排**。是 store 的**消费者**，不创建 store。
- **store（sync-store）**：藏起同步的文件系统。**app 创建**（本模块只调 `file(name).open/save/rename/delete` + `reconcile`）。

## 用

```ts
import { createEditorSession } from "./editor-session/index.ts";

const store = createStore({ provider, ui, crypto, crypt, validateAdopt });   // app 建（含 ui bundle）
const es = createEditorSession({
  store,                                    // app 建好的 store（本模块只消费）
  editor: { adopt, encode, onChange },  // app 的引擎适配器（本模块只调这三个）
  isZip: true,                              // 这个 app 的 doc 是不是 zip 容器（有 peek）
  policy: { autosaveMs: 180_000, pushOn: ["exit"] },   // **app-agnostic**：cadence/push 时机每 app 不同 → 注入
});
es.start();                                 // 挂 autosave timer + 失焦/pagehide 监听（DOM 无则 no-op）

await es.open("MyPainting.ora");            // file.open（含 freshness/冲突 surface/崩溃恢复）→ editor.adopt
await es.flushLocal();                       // 立即存本地（不推）
await es.flushAndPush();                     // 立即存本地 + best-effort 推云
await es.rename("New.ora"); await es.delete();
es.isDirty();                                // **内存脏**（app 层：editor 改过还没落盘）——不是 sync 脏
```

## 铁律

1. **editor 绝不碰 store**。editor 只经本模块的 `adopt`/`encode` 拿/给字节，不知道 name/云/save/push。
2. **本模块不创建 store、不碰 provider/加密/ui**。store 由 app 建（含 ui bundle）；冲突/错误/busy 是 store 的 ui bundle 的事（app 建 store 时接），本模块不转发。
3. **autosave 只本地不推**（`flushLocal`）。opaque Work 的 push 必须 consent-gated（退出/Ctrl+S 才 `flushAndPush`）——见 sync-store ADR-0016/0018。autosave 每 3min 自动推 = 违反 consent。
4. **cadence / push 时机是 policy，不写死**（每 app 不同 → 注入）。本模块只给机制 + 通用触发点。
5. **两种脏别混**（见 CONTEXT.md）：本模块的 `isDirty` = **内存脏**（editor 改过没落盘）；「有没未推到云」是 **sync 脏**，读 `store.listAllItems` 的 syncState，不在本模块。

## 崩溃恢复

`store.file(name).open()` 内部从本地缓存（crash-shadow）重物化——所以「恢复上次 doc」= app 在 boot 调 `es.open(lastDocName)`，本模块无需特殊恢复码。未落盘的内存内容无法恢复（autosave 节律兜底）。
