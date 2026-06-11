# WebPaint 加密（ADR-0012 三层容器 + 统一图库密码 + store operator）

> as-of v234 / 2026-06-11。规范出处：`MyPWAPatterns/docs/encryption-model.md` + ADR-0012（2026-06-02 resolved）。
> 本文记 WebPaint 落地的实现形态、决定与待验项。代码与本文矛盾时信代码。

## 字节布局（文件名明文，文件体换壳）

身份 = path/name（GUID 身份方案 2026-06-07 已否决）——所以**云端/本地文件名保持明文**，
加密只换文件体。日常同步（push/pull/trash/backup）对容器零感知（就是普通字节原样搬）；
「加密/解除」transform 是 **store 底座的 operator**（v234，user 拍板「app-agnostic，不重复造轮子」）。

```
<name>.ora（加密时实为容器）
  outer zip（明文 STORE，CD 干净，扫描器只见 zip 套 zip）
    ├── <GUID>      WinZip-AES-256 zip（zip.js encryptionStrength:3 —— 7-Zip/WinRAR 输密码可开）
    │     ├── data.bin   原始 .ora（扩展名混淆）
    │     └── meta.bin   "WPMETA1\n" + {v,name,ext}（无 app 恢复：解出→按 meta 改回真名）
    └── thumb       [MAGIC 8][ver 1][salt 16][iv 12][len 4LE][AES-GCM(png)]  ← 最后 entry
```

- thumb blob = 容器探测标记（尾部扫 MAGIC）+ byte-range 预览（80KB suffix 一发命中），**必备**。
- KDF 双轨：payload 用 WinZip 标准弱 KDF（换 7z 可开性，不预拉伸）；thumb 用 PBKDF2-SHA256×250k + AES-GCM（GCM tag 兼任密码验证器）。
- salt per-file 在各自 header；无 verifier 文件、无密钥托管、无新增同步面。

## 模块图（store 底座 / app 层两段，v234 下沉后）

**sync-store 底座（`src/store/`，shared-lib dev face —— AtlasMaker/WXHW 迁底座后直接复用）：**

| 文件 | 职责 |
|---|---|
| `store/crypto-container.ts` | 容器纯机制：pack/unpack/探测/thumb blob 加解密/MAGIC 扫描。app-agnostic（data.bin 不透明、ext 参数化）。HOST-SEAM：宿主供 `../zip.js` |
| `store/store.ts` `flow.encrypt/decrypt` | 换文件体 operator：本地先落盘（字节真相）→ 云端 push（If-Match=已见版）→ 失败/412 → **标脏+锚 parentBase=换前云版**，正常 push 流接力收敛。离线+已同步 → 拒（status:offline）。错密码在任何持久改动前抛（code=WRONG_PASSWORD）。单飞守卫 + per-name serialize |
| `store/store.ts` `getTailBytes(name,n)` | 尾部字节原语（file-envelope.md salvage 兑现）——store 不懂缩略图，app 拿尾片自己 scan+解密 |

**app 层（per-app 的部分）：**

| 文件 | 职责 |
|---|---|
| `src/crypto-state.js` | **统一密码**（WebPaint 的 per-app choice）内存态 + 弹窗注入 + `unpackContainerInteractive` |
| `src/zip.js` | + `zipPackEncrypted/zipUnpackEncrypted`（WinZip-AES-256；HOST-SEAM 的提供方） |
| `src/ora.js` | encode/decode **透明**处理容器：`doc._encGuid` 非空 → encode 出容器；decode 见容器 → 交互解锁 |
| `src/enc-thumbs.js` | 图库胶水：`store.getTailBytes` 尾片/云密文 thumb 解密、解锁交互、新密码双输 |
| `src/cloud-thumbs.js` | PNG 硬扫落空 → MAGIC 扫描，命中返**密文** Blob（`ENC_THUMB_MIME`） |
| `src/ui/gallery.ts` | 锁样式 tile、点锁解锁、菜单 intent（调 flow.encrypt/decrypt + 密码 UX + thumbPng 渲制 + 残留清理） |
| `src/gallery-shell.ts` | 图库菜单「解锁/锁定加密作品」 |

## 行为决定（与理由）

- **密码内存 only，关页即忘**；encode 永不弹窗（密码不在 → throw「图库已锁定」，绝不静默存明文）；decode 才交互。
- **解锁后 thumbs 全亮**（统一密码 → 一把钥匙开全部预览，导航不瞎）；锁定/未解锁 → 锁样式。
- **明文 ora / 明文缩略图永不落盘，密文落盘**：IDB 里文件体=容器（离线照常可用），`pkg.thumb=null`、cloud-thumb cache 缓存密文、解出的 PNG 只进 objectURL。
- **加密/解除 = store operator**（图库限非活动 item；活动 doc 的内存态/base 正被 session 编排）。
  v233 教训（已修）：app 层只 `flow.push` 容器不换本地 → 本地留明文 + etag 已采纳 → 下次保存把明文
  又推上去 = **加密被静默撤销**。operator 把「本地+云端一起换」收进深模块强制。
- 加密成功顺手清明文残留：revert checkpoint（`revert:<name>:*`）+ 旧 etag 的 cloud-thumb 缓存。
- **导出（导出项目→ora）对加密作品导出的是容器**（防误导出明文；7z 输密码可恢复）。要明文：先「解除加密」。
- 改名/移动不重写容器 → meta.bin 里的真名滞后到下次保存，只是恢复辅助信息，接受。
- 不强制强密码（规范明文规定）：设密码 sheet 一次性说明「忘记=找不回；弱密码可被暴破；7-Zip 可开」。
- 多密码混库（导入别的库的加密文件）：内存只持最后验证成功的一个，另一密码的文件保持锁样式，打开时重问。

## 验证状态

- ✅ node 24 测（crypto-container 12 + store-crypt 12）：往返/错密码零副作用/探测/尾部窗口/统一密码流/
  operator 两端一起换/离线拒/412 标脏接力收敛/getTailBytes。
- ✅ **互操作性**：测试内含一个不依赖 zip.js 的独立 WinZip-AES 解密器（node:crypto 按 AE-2 规范：
  PBKDF2-SHA1×1000 → AES-256-CTR(LE counter) → HMAC-SHA1 + pwv），逐位解出 data.bin == 原 ora
  —— 两个独立实现互通 ⇒ 格式标准 ⇒ 7-Zip 同理可开。
- ⏳ **真 7-Zip 实测未做**（本机无 7z 二进制）：PC 上从 OneDrive 下载加密 .ora → 7-Zip 解外层 →
  对 `<GUID>` 输密码 → data.bin 改名 .ora 能开。
- ⏳ 真机/桌面待验清单：
  1. 图库菜单「加密保护…」→ tile 变锁；解锁后看到缩略图；锁定后回锁样式
  2. 打开加密作品 → 密码 sheet → 画正常；Ctrl+S / 自动保存 / 退出图库不报错；云端字节确为容器（OneDrive 网页下载验 zip 套 zip）
  3. 错密码 → 「密码不对，再试一次」循环；取消 → 打开失败状态条，不丢数据
  4. 云端纯 cloud 加密项：缩略图锁样式（byte-range 密文路径）+ 拉取打开
  5. 解除加密（含云端在线推送）→ tile 回明文 thumb
  6. revert（恢复到打开时）对加密作品工作（checkpoint 也是容器）
  7. 双 tab / iPad resume 下打开加密作品（ready-gate 流里弹密码的体验）
