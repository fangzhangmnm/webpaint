# dev/prod 分家规范（v121 起，sibling family 抄）

> **目的**：daily 改代码 push 进来时不破坏正在用 PWA 的用户。iPad 不想搭
> localhost 也能远程测最新代码。所有 sibling 项目（ScratchPad / AtlasMaker /
> JustReadPapers / ...）走**同一个规范**，省心智迁移。

## 一句话

`/` = production（**已 promote** 的稳定版本，所有真用户在这）
`/dev/` = development（**daily 提交** 落地处，只有自己 / 测试人员在这）

两套独立入口、独立 bundle、共享 `src/` 和 vendor。

## 仓库结构

```
project-root/
├─ index.html              ← prod 入口（默认用户访问 /）
├─ dev/
│  └─ index.html           ← dev 入口（自己测试访问 /dev/）
├─ src/                    ← ES module 源码（dev 和 prod 共用）
├─ dist/
│  ├─ main-<hash>.mjs      ← prod bundle（content-hash 文件名）
│  ├─ main-<hash>.mjs.map
│  ├─ main-dev.mjs         ← dev bundle（固定名）
│  └─ main-dev.mjs.map
├─ service-worker.js       ← 只服务 prod。dev/ 路径下不注册 SW
├─ scripts/build.sh        ← --dev / --prod 两种 build
├─ vendor/esbuild/         ← vendored esbuild 二进制
└─ src/vendor/             ← UMD 大库（msal / zip-js 等）
```

## 工作流

### 日常开发（daily push）

1. 改 `src/` 里的代码
2. `bash scripts/build.sh --dev` → 生成 `dist/main-dev.mjs`（不 minify，带 sourcemap）
3. `git add . && git commit -m "..." && git push`
4. iPad 浏览器开 `https://<your-host>/<project>/dev/`，刷新即见最新
5. **prod 入口 `/` 完全不动**，真用户继续用上次 promote 的稳定版

dev 入口 HTML 里用 `import('../dist/main-dev.mjs?v=' + Date.now())` 每次刷新强制
拿最新（避开浏览器 HTTP cache）。dev 路径下 app.js 检测到 `/dev/` 子串就**不注册
SW** —— 没有 cache 层，刷新就生效。

### Promote 到 prod（"consent" 之后）

通常意味着 dev 已经实测稳定。"每晚提一次"也是合理节奏。

1. 在仓库根目录跑 `bash scripts/build.sh --prod`
2. 脚本干这几件事：
   - 用 esbuild 重 bundle（minify + sourcemap + content hash）
   - 算 bundle 的 sha256 截 12 位作文件名后缀（如 `main-a3b9c0d12345.mjs`）
   - 清掉 `dist/` 下老的 hashed bundle
   - **sed 改 `index.html`** 里那行 `<script src="./dist/main-XXX.mjs">` 指向新 hash
3. `git add . && git commit -m "promote vXXX → prod" && git push`
4. 用户 PWA 一段时间内还吃旧 bundle（SW cache），SW 后台 revalidate 拿到
   新 `index.html` 就发 toast 通知刷新
5. 用户点刷新 → 加载新 `index.html` → 引用新 bundle hash → 浏览器拿新代码

prod 不进 dev 不走过的代码。promote 是**显式动作**，不是 daily 自动。

### iPad 上同时两个入口

- bookmark 1：`https://<host>/<project>/` → prod，PWA install 给真用户
- bookmark 2：`https://<host>/<project>/dev/` → dev，**不要 install PWA**（防 SW
  cache 污染），用 Safari 标签即可

两个入口共享 `src/vendor/` 和 icon 资源（dev/index.html 用 `../` 引到根目录的
manifest / icons / styles）。但**不共享** SW（dev 不注册）和 PWA install 状态
（prod 才 install）。

## 关键不变量

1. **`/` 入口的 bundle URL 改变** = 一次 prod release。**不要直接 push 改 `index.html`
   引用而不 build**——会指向不存在的 bundle，prod 立刻崩。
2. **`/dev/index.html`** 永远引 `main-dev.mjs`（固定名）。daily push 改的是
   `dist/main-dev.mjs` 内容，**不改文件名**。
3. **service-worker.js** 只服务 prod。dev 不注册 SW 是有意为之。
4. **`src/` 是 bundle 输入**，不是直接被 HTML import 的。HTML 不要 `<script
   type="module" src="./src/app.js">`——一旦这么写，就回退到了"30 个文件版本对齐"
   的老坑。
5. **vendor 大库**（msal / zip-js）放 `src/vendor/` 不入 bundle，通过 classic
   `<script>` 或动态注入加载。两套入口都从根目录 `./src/vendor/` 共享。

## 抄给 sibling family 时的 checklist

- [ ] vendor esbuild 二进制到 `vendor/esbuild/esbuild`（用你 OS 的版本，**别入 git**）
  ```bash
  # Linux x64（WSL 也用这个）：
  curl -sL https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.24.0.tgz \
    | tar -xz -C /tmp \
    && mkdir -p vendor/esbuild \
    && mv /tmp/package/bin/esbuild vendor/esbuild/esbuild \
    && chmod +x vendor/esbuild/esbuild
  ```
  其它 OS 改 `linux-x64` → `darwin-arm64` / `darwin-x64` / `win32-x64`。
  npm 包名 `@esbuild/<os>-<arch>`。版本号自己挑（这套基于 0.24.0 测过）。
- [ ] 抄 `scripts/build.sh`，改顶部的 `ENTRY` 指向项目入口模块（一般 `src/app.js`）
- [ ] 抄 `service-worker.js`，改 `STATIC_PRECACHE` 列表里的 icons / styles / vendor 路径
- [ ] 抄 `dev/index.html` 模板，改 title 和 asset 路径
- [ ] 项目根 `index.html` 里入口改成 `<script type="module" src="./dist/main-XXX.mjs">`
      （bump 之后 build.sh 会自动 sed 改）
- [ ] 在 `src/version.js` 改成 ES module 形式 `export const PROJECT_VERSION`
- [ ] CLAUDE.md 加一条提醒：「daily push 跑 build.sh --dev，promote prod 跑 --prod」

## 老 sibling 项目迁移路径

迁过来的成本主要在：
- 把 vendor 模块的 `import.meta.url` 改成 `document.baseURI`（bundle 后 import.meta.url
  会指 `dist/main-XXX.mjs`，相对路径就错位置了）
- 删 `?v=VERSION` 形式的 import URL（bundle 内没有这种 import 了）
- 删任何"SW importScripts version.js"的 hack
- 把版本 SSoT 文件改成 ES module export

老 SW 老 index.html 全删，照本规范重写。

## 必踩的坑（写在前面）

1. **`.gitignore` 里如果有 `dist/`，立刻删掉**。早期 webapp 模板常加 `dist/`
   （因为很多项目里 dist 是本地产物、CI 在线 build）。我们这套**dist 必须
   commit 进 git**，因为 GitHub Pages 直接 serve repo 文件，你不 push 它就没有。
   一旦遗忘，prod URL 引用的 `dist/main-XXX.mjs` 是 404，prod 立刻全崩。
   v121 第一次切的时候我自己踩了一脚。**抄到 sibling family 时第一件事检查
   `.gitignore`**。
2. **不要把 `dist/main-tmp.mjs` 这种中间产物 commit**。build.sh 写中间文件再
   mv 成最终 hashed 名；如果 mv 之前你手 ctrl-c 了，tmp 还在。`.gitignore` 排
   它一下。
3. **vendor/esbuild 二进制不入库**（10MB），跨 OS 也不通用。docs 写清楚
   "新机器跑这个 curl 命令" 就行。
4. **`dev/index.html` 里 `<base href="../">` 必须有，且在所有 `<link>` / `<script>`
   之前**。不加的话，bundle 里 `new URL("./src/foo.js", document.baseURI)` 会
   解到 `/<repo>/dev/src/foo.js`（dev/ 这层不存在 src/），404。v121 user 立刻撞
   `MSAL load failed .../dev/src/vendor/msal/...`。
   加 `<base href="../">` 后 dev/ 里所有相对路径回 `./...` 跟 prod 同写法，
   bundle 内 `import.meta.url` / `document.baseURI` 都解到项目根。
   **绝对位置必须紧贴 `<head>`**：base 只对它后面出现的 URL 生效。
