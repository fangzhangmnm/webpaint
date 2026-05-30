# dev / prod 分家（v122 起，branch + GH Actions）

> **这件事是可选的**。只有项目同时满足三条才值得搞：
> 1. 有**外部用户**（不是只你自己用）
> 2. 用户**有数据在 PWA 里**（画 / 笔记 / 配置）—— 一个 bug 会让人丢东西
> 3. 别人会 **dependency 这个 URL**（导入你的 module、把链接发给朋友）
>
> WebPaint 三条都中。
> JustReadPapers、Background Radio 之类的纯读项目可能根本不需要，单分支保持简单更好。
> 抄前先评估，**别每个 sibling 都套**。

## 一句话总结

`main` 分支 = 工作区，daily push 这里
`prod` 分支 = 上次 promote 时 main 的 fast-forward snapshot

GH Actions 把两个分支组合成一个站，prod 在 `/`，main 在 `/dev/`。

iPad URL：
- `https://<user>.github.io/<repo>/`     ← prod（真用户）
- `https://<user>.github.io/<repo>/dev/` ← dev（你 + AI 测）

## 源 repo 结构

```
project-root/
├─ index.html               ← 引 ./dist/main-<hash>.mjs
├─ styles.css               ← 运行时资源（HTML <link> 拉）
├─ default-brushes.json     ← 运行时资源（fetch；SW precache 离线兜底）
├─ vendor/                  ← 运行时 UMD lib（zip-js / msal 等）
├─ icon.svg / icon-*.png
├─ apple-touch-icon-*.png
├─ manifest.webmanifest
├─ service-worker.js
├─ src/                     ← 纯 build input（.js 代码）。删了重 build 能完整复原
├─ dist/main-<hash>.mjs     ← esbuild bundled，commit 进 git
├─ scripts/build.sh
├─ .github/workflows/deploy.yml
├─ tools/esbuild/           ← gitignored 构建工具（build.sh 自动 curl）
└─ docs/, journal/, README ...
```

**分类原则**：
- **根目录**：运行时资源（浏览器会 GET 的文件）+ 入口 + 构建产物 + PWA 元数据
- **src/**：纯构建输入。bundle 后 `src/*.js` 运行时不被请求；`src/` 整个删了重 build 能复原
- **vendor/**：运行时 UMD lib（commit 进 git，跟 styles 一样是运行时资源）
- **tools/**：构建工具（gitignored，跨 OS 不通用）

dev / prod 不在文件夹分，**在 git 分支分**。`dist/main-<hash>.mjs` 是源树唯一的 build artifact。

## 工作流

### Daily（dev 推送）

1. 编辑 `src/...` 或 `index.html`
2. `bash scripts/build.sh` —— bundle src/ → dist/main-<hash>.mjs，sed 改 index.html 引新 hash
3. `git add . && git commit && git push origin main`
4. **GH Actions 自动跑** ~30 秒 → /dev/ 部署
5. iPad 开 `<host>/<repo>/dev/`，刷新即新版

### Promote 到 prod（**push prod 必须问人**）

**唯一**的死规则：**push 到 prod 必须人手动**，AI 不擅自做。

```bash
git checkout prod
git merge --ff-only main      # ff-only：拒非线性合并，保 prod 历史线性
git push origin prod
git checkout main             # 立刻切回
```

Actions 自动跑 → / 部署完。真用户下次刷新见新版。

### 第一次 setup（一次性）

1. `git checkout -b prod && git push -u origin prod`
2. GitHub UI：Settings → Pages → Source 改 "GitHub Actions"
3. （可选）Settings → Branches → 给 `prod` 加 protection rule

## AI 工作规则

唯一规则：**push prod 前问人**。

不罗列死规则。AI 信任 + 一个 hard checkpoint。

## 为啥不是别的方案

| 方案 | 否的原因 |
|---|---|
| 两 repo (webpaint + webpaint-dev) | GitHub account pile of shame；msal 重定向 URI 翻倍调 |
| folder mirror (/ 和 /dev/ 同 repo 两份) | 文件夹 mirror 是 hack 不专业；AI 改错文件夹 risk 实在 |
| 单分支 + feature flag | dev 烂代码仍影响真用户；AI 安全 = 0 |
| 单分支 + git tag | tag 不解决"daily / promote"分离，只是 mark 历史 |

行业对照：NumPy 是 tag + PyPI 外部存储；React 是 branch + npm tag；Vercel apps 是 branch + preview URL。**统一规律**：dev/prod 通过 **deploy target / branch ref** 区分，不通过源树文件夹。

我们这套（branch + Actions Pages 子路径）是这个规律在静态 PWA 下的合理化身。

## 抄给 sibling family checklist

如果判断需要分家：

- [ ] 抄 `scripts/build.sh`，改顶部 `ENTRY` 指向项目入口（一般 `./src/app.js`）
- [ ] 抄 `.github/workflows/deploy.yml`
- [ ] `.gitignore` 加 `vendor/esbuild/`、`dist/main-tmp.mjs*`
- [ ] index.html 入口改成 `<script type="module" src="./dist/main-<hash>.mjs"></script>`
- [ ] `src/version.js` 是 ES module export
- [ ] `git checkout -b prod && git push -u origin prod`
- [ ] GitHub UI：Pages source 改 "GitHub Actions"
- [ ] OAuth：/ 和 /dev/ 两条 redirect URI 都要存在

老 sibling 项目（有 dist/ 在 git 但路径不一致的）：
- 删 SW 里 `manifest.json` hash 校验、`importScripts version.js`、`?v=` import 重写
- 删任何"为 PWA 缓存绕路"的奇技
- 改 vendor lib 加载用 `document.baseURI` 而非 `import.meta.url`（bundle 后才不错位）

## 必踩坑

1. **prod 分支不存在就推 main**：Actions 第一步 checkout prod fail。先建 prod 分支再 push。
2. **index.html 里 dist 路径手改了 / sed 找不到**：build.sh 用 sed 替 `main-XXX.mjs`，如果你（或 AI）跑过 build 然后 commit 了 patched 版本，下次跑 sed 还是能找到（它匹配任何 12 位 hex hash），但万一你手改成完全不同的写法，sed 就静默失败。**别手改那一行**。
3. **Actions concurrency**：两个分支同时 push 会排队跑 Actions（pages 不能并发部署）。可接受。
4. **vendor/esbuild 二进制不入 git**（10MB + 跨 OS 不通用）。build.sh 自动 curl 安装。新机器或 CI 第一次跑 build.sh 多 5-10 秒下载，之后 cached。
