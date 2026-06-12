# WebPaint 加密（ADR-0012 三层容器 + 统一图库密码 + store operator + .7z 强 KDF）

> as-of v236 / 2026-06-12。规范出处：`MyPWAPatterns/docs/encryption-model.md` + ADR-0012（含 2026-06-12 修订）。
> 本文记 WebPaint 落地的实现形态、决定与待验项。代码与本文矛盾时信代码。

## 字节布局（文件名明文 + .zip，文件体换壳）

身份 = path/name（GUID 身份方案 2026-06-07 已否决）——**文件名保持明文**，加密只换文件体。
加密文件的外部扩展名 = **`.zip`**（容器本来就是标准 zip，名实相符、防软件按 .ora 误认；
txt 加密了也是 .zip）。日常同步（push/pull/trash/backup/rename）对容器零感知（普通字节原样搬）；
「加密/解除」与「包壳/解壳」全是 **store 底座 operator**（user 拍板「app-agnostic，不重复造轮子；
store 不能对文件格式有任何预设」）。

```
<name>.zip（加密容器；明文文件仍是 <name>.ora）
  outer zip（明文 STORE，CD 干净，扫描器只见 zip 套 zip）
    ├── <GUID>      加密 .7z payload（AES-256 + 强 KDF + 加密头 -mhe，vendored 7z-wasm 造）
    │     ├── data.bin   原始 .ora **逐字节不动**（自带 Thumbnails/thumbnail.png → 7-Zip 解出即正常带缩略图文件）
    │     └── meta.bin   "WPMETA1\n" + {v,name,ext}（无 app 恢复：解出→按 meta 改回真名）
    └── peek        [MAGIC 8][ver 1][salt 16][iv 12][len 4LE][AES-GCM(不透明字节)]  ← 最后 entry
```

- **peek = 不透明字节**（store 永不解释）。WebPaint 的解释 = 缩略图 PNG（装配时 `makePeek` 从 ora 抽
  `Thumbnails/thumbnail.png`）；文本类 app 可放摘要。peek blob 兼任容器探测标记（尾扫 MAGIC）+
  byte-range 预览（80KB suffix 一发命中）。**空 peek 也写**（探测标记必须在）。
- 密码学：**payload = .7z AES-256 + 强 KDF**（7-Zip 默认 SHA-256 多轮）+ 加密头，7-Zip 输密码直开；
  peek 强 KDF（PBKDF2-SHA256×250k）+ AES-GCM（GCM tag 兼任密码验证器）。salt 在各自 header；
  无 verifier 文件、无密钥托管、无新增同步面。
- **vendored 7z-wasm**（`vendor/7z-wasm/`，~1.6MB，user 2026-06-12「还是 vendor 7z，兄弟项目有高安全需求」）：
  **惰性 + 不进 bundle + 不 precache**——`src/sevenzip.js` 首次加密/解密才注入 UMD + fetch wasm，
  SW 运行时缓存（msal 同款）→ 用过一次即离线可用，不加密的用户零下载。HOST-SEAM：crypto-container
  调 `../sevenzip.js` 的 pack7z/unpack7z（同 zip.js 注入方式），node 测经 setSevenZipLoader 注入。
- 为什么不直接 bare .7z（一步恢复）：整文件得是 zip 才能塞尾部 byte-range peek（云端加密缩略图）。
  user 2026-06-12 选「保 peek，恢复两步」。恢复：7-Zip 开 .zip → 取 <GUID> → 改名 .7z → 输密码。

## 模块图（store 底座 / app 层两段）

**sync-store 底座（`src/store/`，shared-lib dev face —— AtlasMaker/WXHW 迁底座后直接复用）：**

| 文件 / 表面 | 职责 |
|---|---|
| `store/crypto-container.ts` | 容器纯机制：pack/unpack/探测 + peek 加解密 + MAGIC 扫描。**格式盲**（data.bin/peek 都是不透明字节、ext 参数化）。HOST-SEAM：宿主供 `../zip.js` |
| `flow.save / flow.load` | 本地落盘/读取**透明**：encode 出明文→按加密态自动包壳；load 自动解壳出明文（锁定→status:locked）。明文绝不落盘 |
| `flow.push / open / acquire` | 同步路径同样透明：encode 出明文 store 包壳后推；adopt 收到的已解壳为明文 |
| `flow.encrypt / decrypt` | 切换加密态：本地先落盘→云端 If-Match push（.zip 翻转）→失败/412 标脏+锚 parentBase 接力收敛；离线+已同步拒 |
| 密码 seam（注入） | `getPassword`(同步非交互) / `requestPassword`(交互兜底，store 在解壳路径循环) / `onPasswordVerified`(验证通过回调 app 记忆)。**store 不存密码** |
| `getTailBytes / decryptPeekBytes / readPeek` | 读侧原语：tail 本地/云端自动路由；peek 解密走密码 seam（非交互缺省）。`isEncrypted` / `loadRaw` / `seal` / `unseal` |

**app 层（per-app 的部分；解释/政策都在这）：**

| 文件 | 职责 |
|---|---|
| `src/crypto-state.js` | 密码**政策** = 统一密码 + per-name 覆盖（导入别库文件密码不同）；`getPassword/requestPassword/onPasswordVerified` 三件喂给 store seam；弹窗实现由 composition root 注入 |
| `src/zip.js` | + `zipPackEncrypted/zipUnpackEncrypted`（HOST-SEAM）+ `zipReadEntry`（makePeek 从 ora 抽缩略图） |
| `src/app-store.js` | 装配点：注入 `crypt:{ext:"ora", makePeek, getPassword, requestPassword, onPasswordVerified}` + cloud 的 `encFileName`（.zip） |
| `src/ora.js` | **纯 codec**：encode 永远出明文 ora、decode 永远收明文 ora（加密完全不可见） |
| `src/enc-thumbs.js` | 把 store 解出的不透明 peek 字节解释成 image/png Blob + 设新密码双输 UX |
| `src/cloud-thumbs.js` | PNG 硬扫落空 → MAGIC 扫描，命中返密文 Blob（`ENC_PEEK_MIME`），解密归 caller |
| `src/ui/gallery.ts` | 锁样式 tile（readPeek 非交互）、点锁解锁（readPeek 交互）、菜单 intent（调 flow.encrypt/decrypt）、**常驻加密徽章**（解锁后也显示小锁） |
| `src/config.js` | `encSessionFileName`（.zip）+ `stripSessionExt`（.ora/.zip 都剥；所有去扩展名走这里） |
| `src/sevenzip.js` | .7z 加密原语（vendored 7z-wasm 惰性加载）：pack7z/unpack7z + setSevenZipLoader（node 测注入） |
| `src/session-state.ts` | **画板加密**：encryptCurrent/decryptCurrent（saveNow→flow.encrypt/decrypt）+ 反应式 `enc.encrypted` |

## UI（v236：图库 + 画板都可见）

- **画板菜单**：「加密保护…/解除加密…」（label 随当前画作加密态切）。
- **画板顶栏**：当前画作加密时常驻小锁（点它=解除加密）。明文时 hidden。反应式跟 `session.enc.encrypted`。
- **图库 tile**：未解锁→锁样式占位 + 点锁解锁；**解锁后**缩略图旁常驻小锁徽章（一眼看出加密，不只靠锁定态）。

## 行为决定（与理由）

- **save/load/push/pull 对 app 全透明**：encode 出明文、adopt/load 收明文，包壳解壳全在 store。
  本地 IDB 也走 `flow.save/load`（缝上「本地持久化绕过深模块」的历史裂缝）。
- **密码内存 only，关页即忘**；保存路径密码不在 → store 抛 `LOCKED`，**绝不静默存明文**；解壳路径才交互弹窗。
- **解锁后 thumbs 全亮**（统一密码 → 一把钥匙开全部预览，导航不瞎）；批量渲染非交互（锁定→锁样式，不弹窗伏击）。
- **明文 ora / 明文缩略图永不落盘，密文落盘**（离线照常可用）：IDB 文件体=容器，`pkg.thumb=null`，
  cloud-thumb cache 缓存密文，解出 PNG 只进 objectURL。
- **encrypt/decrypt 两端一起换**（图库限非活动 item）。v233/234 教训（已修）：只换一端 = 下次保存把明文推回 = 加密被静默撤销 → operator 强制两端一起换。
- checkpoint（revert）走 `store.seal` 包壳存、`store.unseal` 解壳读 → 加密作品的明文快照也不落盘。
- 导出（导出项目）对加密作品导出**密文容器**，下载名 .zip（防明文泄漏口；7z 输密码可恢复）。要明文先解除加密。
- 密码政策一个 seam 吃三种：统一（WebPaint/WXHW）、per-file（AtlasMaker）、全局+per-name 覆盖（混库导入件）。

## 验证状态

- ✅ node 24 测全过（269；crypto-container 13 + store-crypt 14）：容器往返/空 peek/错密码零副作用/探测/
  尾窗口 + operator 透明 save/load（明文不落盘、LOCKED、密码循环+记忆）/两端一起换 + .zip 翻转/
  离线拒/readPeek 非交互不弹窗/isEncrypted。
- ✅ **7z 互操作（node 内）**：测试用**全新 7z-wasm 实例**（= 另一台机器的 7-Zip）输密码解 payload →
  data.bin 逐位 == 原 ora，且 payload 头是 .7z magic（`37 7a bc af 27 1c`）⇒ 真 .7z，7-Zip 可开。
- ✅ build 验证：1.6MB wasm **不在 bundle 里**（esbuild 只见字符串路径），惰性加载保住。
- ⏳ **真桌面 7-Zip 实测未做**（本机无 7z 二进制）：PC 从 OneDrive 下 `<name>.zip` → 7-Zip 解外层 →
  对 `<GUID>` 改名 .7z → 输密码 → data.bin（完整 ora，自带缩略图）改名 .ora 能开。
- ⏳ **承诺的「一步恢复」单文件解密 HTML 未做**（避免上线未测的数据安全工具；先文档化手动两步）。
- ⏳ 真机/桌面待验清单：
  1. **wasm 惰性加载 + SW 离线缓存**：首次加密在线触发 1.6MB 下载；之后离线能加密/解密（cache 命中）
  2. 「加密保护…」（图库 + 画板菜单）→ tile/顶栏出锁；解锁后缩略图 + 常驻锁徽章；云端文件名变 .zip
  3. 打开加密作品 → 密码 sheet → 画正常；Ctrl+S / 自动保存 / 退出图库不报错；boot 恢复加密作品弹密码
  4. 错密码 → 「密码不对，再试一次」循环；取消 → 失败状态条，不丢数据
  5. 云端纯 cloud 加密项：缩略图锁样式（byte-range 密文路径）+ 拉取打开
  6. 7z 加解密耗时（1.6MB wasm spin-up + AES）在 iPad 上可接受否
  5. 解除加密（含云端在线推送）→ tile 回明文 thumb，云端名翻回 .ora
  6. revert 对加密作品（checkpoint 密文往返）；导入外来 .zip 容器（unseal 弹密码）；导出加密作品 = .zip 密文
  7. 双 tab / iPad resume 下打开加密作品
