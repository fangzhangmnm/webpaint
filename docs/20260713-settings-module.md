# settings 深模块（唯一入口 + local/synced 路由）

> as-of v395+ / 2026-07-13 · `src/settings-core.ts`（纯逻辑）+ `src/settings.ts`（接真 store）

## 目标

所有设置读写走**一处** `getSetting/setSetting`（不再各模块散碰 localStorage 设置键）。一处注册表 `SETTINGS` 声明每个设置的 **scope**（`local`=设备本地 / `synced`=跨设备跟人）+ default + 旧键迁移。模块负责路由。

## 分层

- **`settings-core.ts`**：纯逻辑 + 注册表，无 store/DOM 依赖 → node 可测（`test/settings-core.test.mjs`）。`createSettings(backends)` 注入后端。
- **`settings.ts`**：唯一入口。装配后端 + `initSettings`（拉云 + 通知 theme 重贴）+ `onSyncedSettingChange`。

## 路由

- **local** → localStorage KV（键前缀 `webpaint.set.`）。语义 == store.localSettings（设备本地）。
- **synced** → 上面的本地 KV **镜像**（同步秒读、boot 安全、离线安全）**+** `store.syncedSettings`（跨设备权威，collection-backed，per-key LWW）。

### 为什么 synced 也要本地镜像

`theme`/`lang` 在**模块 eval 期**就被读（brush-rack 等模块的 `t()` 常量在 import 时已跑），早于 `store.syncedSettings.init()`（异步拉云）。镜像 = 本设备「上次见到的值」，localStorage 同步秒读；`initSettings` 拉云后把云端值折回镜像 + 触发 `onSyncedSettingChange`（theme 重贴 / lang 下次 boot 生效）。跨设备权威仍是 syncedSettings。

## 为什么 settings.ts 刻意不 import app-store

`t()`/theme 被极多 leaf 模块与 node 测用。若 settings 静态 import app-store，就把整个 store/crypto（7z-wasm/msal）栈塞进每个用 `t()` 的模块 = 耦合 + node 测崩 + i18n↔store-ui 成环。

故：settings 只依赖 `settings-core` + `safe-ls`；**synced 后端由 app-store 建好 store 后惰性注入**（`wireSyncedSettings(store.syncedSettings)`，app-store eval 期一行）。注入前 synced 项只走本地镜像（boot 安全）。方向单一 `app-store → settings`，无环。

## 迁移

旧散键（`webpaint.pToSize`/`webpaint.size`/`webpaint.synced` blob/`webpaint:exportProject:v1`…）由每条 spec 的 `legacy(ls)` 读时兜底，首次 get 落进新后端（`webpaint.set.<key>`）。一次性，之后改新值不被旧键盖回。

## 已路由的设置（注册表）

- **local**：pressureToSize / pressureToOpacity / longPressPick / singleFingerDraw / pixelGrid / fps / pickMode / lastSize / lastOpacity / lastColor / colorPanelPos / layersPanelPos / galleryFolder / exportProject / exportImage / importImage。
- **synced**：theme / lang。

### 有意**不**收进本模块的（非「设置」或另有归属）

- **per-doc**：checkerboard（跟文件走，v125 起进 ORA state）。
- **session 身份**：currentSessionName（session.ts 拥）。
- **dev/工具瞬态**：`webpaint.smooth.v4`（dev 平滑参数）、liquify.bleed（sticky 工具选项）、reference panel 几何、blender remoteUrl/panel（设备级、blender-sync 自管）。

如需把上述某项也纳入路由：在 `SETTINGS` 加一条（scope + def + legacy），再把 callsite 换成 getSetting/setSetting。
