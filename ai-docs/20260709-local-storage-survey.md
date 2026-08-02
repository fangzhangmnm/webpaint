      下面是从本次调查里汇总的全部字段。分 IDB 和 localStorage 两块,每块再分 WebPaint / JRP。
                                                                                                                                                            IndexedDB

      WebPaint —— DB webpaint (version 2)

    ┌──────────┬────────────────────────────────────────────┬─────────────────────────────────────────┬─────────────────────────────────────────────    │  store   │                    key                     │                记录结构                 │                     说明                      │
    ├──────────┼────────────────────────────────────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────┤
    │          │                                            │ SessionPkg { name:string,               │ 一个 session = 一个原子包,一次 put 一个       │
    │ sessions │ session name(默认 "current")               │ updatedAt:number, ora:Blob,             │ tx(要么全有要么全无)                          │
    │          │                                            │ thumb:Blob|null }                       │                                               │
    ├──────────┼────────────────────────────────────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────┤
    │ sessions │ trash:<ts>[-<counter>]:<name>              │ 同上                                    │ 软删=在同 store 内 rename 到 trash 前缀       │
    ├──────────┼────────────────────────────────────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────┤
    │ sessions │ .backup-local/<yyyymmddhhmmss-guid>:<name> │ 同上                                    │ 覆盖前留底                                    │
    ├──────────┼────────────────────────────────────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────┤
    │ meta     │ "brush-rack"                               │ 笔架预设 JSON(+云同步)                  │ 注释说"保留给                                 │
    │          │                                            │                                         │ settings/theme",实际当前只装了笔架            │
    ├──────────┼────────────────────────────────────────────┼─────────────────────────────────────────┼───────────────────────────────────────────────┤
    │ meta     │ cloud-thumb:* / revert:*:ora / revert:*:at │ 云缩略缓存 / checkpoint                 │ 非设置类                                      │
    └──────────┴────────────────────────────────────────────┴─────────────────────────────────────────┴───────────────────────────────────────────────┘

    字节字段叫 ora;按 name 键。

    JRP —— DB sync-store-cache (version 1)

    ┌───────┬──────────────────────────────┬───────────────────────────────────────────────────────────┬──────────────────────────────────────────────┐
    │ store │             key              │                         记录结构                          │                     说明                     │
    ├───────┼──────────────────────────────┼───────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
    │ blobs │ name                         │ CacheRecord { blob:Blob, thumb:Blob|null,                 │ 内容盲,不透明 blob,不渲 thumb(只收           │
    │       │                              │ updatedAt:number }                                        │ hint.thumb)                                  │
    ├───────┼──────────────────────────────┼───────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
    │ blobs │ local-trash:<stamp>:<name>   │ 同上                                                      │ 软删                                         │
    ├───────┼──────────────────────────────┼───────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
    │ blobs │ .backup-local/<stamp>:<name> │ 同上                                                      │ 留底(前缀与 WebPaint 一致)                   │
    ├───────┼──────────────────────────────┼───────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
    │ blobs │ __collection__/…             │ collection 内部 JSON                                      │ collection 落本地兜底                        │
    └───────┴──────────────────────────────┴───────────────────────────────────────────────────────────┴──────────────────────────────────────────────┘

    字节字段叫 blob;按 name 键。结构与 WebPaint 逐字段同(ora↔blob、thumb、updatedAt),只差名字 + WebPaint 多一个冗余 name 字段。

    localStorage

    store 内部同步状态(两边模板逐字符相同,只差前缀)

    ┌──────────────────────────┬────────────────────────────┬────────────────────────────────────────┬────────────────────────────────────────────────┐
    │         key 模板         │             值             │                WebPaint                │                      JRP                       │
    ├──────────────────────────┼────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────────────────┤
    │ <appKey>.etag:<name>     │ etag 字符串(云版本号)      │ appKey=webpaint                        │ 默认 sync                                      │
    ├──────────────────────────┼────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────────────────┤
    │ <appKey>.dirty:<name>    │ "1"/"0"                    │ cloud-sync,缺失=脏                     │ collection 用(sync.dirty:)                     │
    ├──────────────────────────┼────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────────────────┤
    │ <keyPrefix>.dirty:<name> │ "1"/删除                   │ —(WebPaint 工作文件也走上面            │ 工作文件走                                     │
    │                          │                            │ cloud-sync)                            │ local-head,keyPrefix=head,缺失=clean           │
    ├──────────────────────────┼────────────────────────────┼────────────────────────────────────────┼────────────────────────────────────────────────┤
    │ folders.pending          │ JSON                       │ —                                      │ 有                                             │
    │                          │ 数组(离线建的空夹路径)     │                                        │                                                │
    ├──────────────────────────┼────────────────────────────┼────────────────────────────────────────┼─────────────────────────────    │ settings:<key>           │ JSON 值                    │ store.settings(定义了但 0 调用)        │ localSettings 默认命名空间                     │
    └──────────────────────────┴────────────────────────────┴────────────────────────────────────────┴────────────────────
    ▎ syncedSettings 不落 localStorage——它是一个 collection(云端 JSON),每个 setting 一个 item {id:key, v:值}。                           
    WebPaint app 散落设置(~23 个,store 外)

    设备偏好(应进 localSettings):
    - webpaint.theme → "auto"|"day"|"night"(新值实写进 webpaint.synced blob,散键仅迁移兜底)                                                              - webpaint.lang → "zh"|"en"|"ja"|"tok"(同上)                                                                                                             - webpaint.synced → JSON blob {lang, theme}(syncable-prefs 唯一聚合点)
    - webpaint.pixelGrid → bool(像素栅格,默认开)
    - webpaint.fps → bool(FPS 叠层,默认关)                                                                                                        - webpaint.pToSize / webpaint.pToOpacity → bool(压感→粗细/透明)
      - webpaint.longPressPick → bool(长按吸色)

设备偏好(应进 localSettings):
- webpaint.theme → "auto"|"day"|"night"(新值实写进 webpaint.synced blob,散键仅迁移兜底)
- webpaint.lang → "zh"|"en"|"ja"|"tok"(同上)
- webpaint.synced → JSON blob {lang, theme}(syncable-prefs 唯一聚合点)
- webpaint.pixelGrid → bool(像素栅格,默认开)
- webpaint.fps → bool(FPS 叠层,默认关)
- webpaint.pToSize / webpaint.pToOpacity → bool(压感→粗细/透明)
- webpaint.longPressPick → bool(长按吸色)
- webpaint.singleFingerDraw → bool(单指作画)
- webpaint.pickMode → "composite"|"layer"(吸色取样)
- webpaint.size / webpaint.opacity → number(上次笔刷粗细/透明,启动种子)
- webpaint.color → hex(上次颜色,默认 #1b1b1b)
- webpaint.liquify.bleed → 液化 bleed 模式(默认 edge)
- webpaint.smooth.v4 → JSON(平滑参数 tauMaxMs/tailBow/…,dev 面板)
- webpaint.blender.remoteUrl → string(Blender 地址)

面板位置/UI 布局(设备本地):
- webpaint.colorPanel.pos → {left,top}
- webpaint.layersPanel.pos → {left,top}
- webpaint.blenderPanel.pos → {left,top}
- webpaint.refPanel.pos → {left,top,width,height}
- webpaint.refPanel.vp → {tx,ty,scale,rot}(参考图 viewport)
- webpaint.refPanel.open → "1"|"0"
- webpaint.galleryFolder → 当前图库文件夹路径 string

导出/导入 sticky 偏好(内容型,现设备本地——该进 syncedSettings):
- webpaint:exportProject:v1 → {format:"ora"|"psd"}
- webpaint:exportImage:v1 → {format, target, scope}
- webpaint:importImage:v1 → {source:"file"|"clipboard"}

运行时状态(不是设置):
- webpaint.currentSessionName → 当前活动 session 名(运行时指针,boot 失败不重置)
- webpaint.lastSessionSignedIn → 上次是否登录的提示位

▎ 注:webpaint:active/clipping/id/reference 是 .ora 文件内的 XML 属性,不是 localStorage,别混进来。

JRP API 里"一张画"是不是叫 file?

是。 JRP 的 API 里一张画/一个文档就是 store.file(name, {isZip}),返回一个绑定该 name 的对象(save/open/rename/delete/keepOffline/offload/isDirty/encrypt/decrypt/…)。细分两型(编译期分):
- ZipFile({isZip:true})—— .ora 这类 zip 容器格式,多一个 getPreview()(缩略图)。WebPaint 的画走这个。
- RawFile({isZip:false})—— pdf/txt 这类不透明字节,无预览。JRP 的论文走这个。

身份 = path/name(格式无关、无 GUID)。另外 store.collection(name) 是另一类东西——一份同步 JSON 装一堆原子 item(reading-state、笔架、syncedSettings 都是 collection),不是 file。所以:画 = file(具体是 ZipFile);笔架/设置/阅读位置 = collection。

---

下面按"从底层容器到具体存哪"科普一遍浏览器存储,再落到你项目里的用法。                                                                               
一、浏览器有哪些存储机制(全景)

┌──────────────────────────────────┬─────────────────────────┬──────────────────────────────┬────────────────────┬────────────────────────────┐
│               机制               │          容量           │           能存什么           │     同步/异步      │          典型用途          │     ├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ localStorage                     │ ~5–10MB                 │ 只能存字符串                 │ 同步(阻塞)         │ 小配置、标志位、偏好       │
├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ sessionStorage                   │ ~5MB                    │ 字符串                       │ 同步               │ 单标签页临时态(关页即丢)   │
├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ IndexedDB                        │ 很大(几百 MB~GB,按配额) │ 任意结构化数据 + Blob/二进制 │ 异步(Promise/事件) │ 大文件、离线缓存、复杂数据 │
├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ Cache Storage(Service Worker)    │ 大                      │ HTTP 请求/响应对             │ 异步               │ PWA 离线资源、网络缓存     │
├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ Cookies                          │ ~4KB/条                 │ 字符串,随每次请求发服务器    │ 同步               │ 会话票据、服务端读的东西   │
├──────────────────────────────────┼─────────────────────────┼──────────────────────────────┼────────────────────┼────────────────────────────┤
│ OPFS(Origin Private File System) │ 大                      │ 真·文件句柄                  │ 异步               │ 高性能文件读写(较新)       │
└──────────────────────────────────┴─────────────────────────┴──────────────────────────────┴────────────────────┴────────────────────────────┘

几个共同点:
- 按 origin 隔离(协议+域名+端口)。https://a.com 存的,https://b.com 读不到。
- 都可能被清除:用户清缓存、浏览器配额压力驱逐(尤其 iOS Safari)、隐私模式关页即焚。所以没有一个是"安全保险箱"——这也是你项目里"未推脏字节 = 世界唯一副本"要格外小心的原因。
- 持久化承诺:navigator.storage.persist() 可申请"别随便驱逐我",但不保证。

二、localStorage —— 最简单的键值对

就是一个 字符串 → 字符串 的表:

localStorage.setItem("webpaint.theme", "night");  // 存
localStorage.getItem("webpaint.theme");           // 读 → "night"
localStorage.removeItem("webpaint.theme");        // 删

- 只能存字符串。要存对象就 JSON.stringify 进去、JSON.parse 出来(你项目里 webpaint.synced 就是一个 JSON blob 字符串)。
- 同步:读写会阻塞主线程,所以只适合小东西,别塞大数据。
- key 是扁平的全局命名空间,没有层级。所以大家用前缀当"伪命名空间":webpaint.etag:xxx、settings:key——冒号/点只是约定,不是语法。

你项目里 localStorage 装的都是小而多的元数据:同步状态(etag、dirty 标志)、设备偏好(主题/语言/面板位置)、运行时指针(currentSessionName)。

三、IndexedDB —— 浏览器内置的"对象数据库"

这是最容易被名词绕晕的。层级从大到小:

Database(库)  ——  你 open 一个,有名字 + 版本号
└─ Object Store(对象仓)  ——  类似 SQL 的"表",一个库里可多个
    └─ Record(记录)  ——  一个 key → 一个 value

1. Database(库) — 用名字打开,带一个整数版本号:
const req = indexedDB.open("webpaint", 2);   // 库名 "webpaint",版本 2
版本号是结构迁移机制:版本变大时触发 onupgradeneeded,你在里面建/改 object store。这是 IDB 里唯一能改结构的地方。

2. Object Store(对象仓) — 库里的"表",在 onupgradeneeded 里创建:
db.createObjectStore("sessions");   // 建一个叫 sessions 的仓
db.createObjectStore("meta");       // 再建一个 meta

3. Record(记录) — 一个 key → value:
- key 可以是字符串/数字等。你项目里用 session name 当 key(比如 "current"、"trash:123:画名")。
- value 可以是任意可结构化克隆的东西:对象、数组、Blob(二进制)、ArrayBuffer 等——这是 IDB 相对 localStorage 的杀手锏,能直接存二进制大文件,不用 base64 编码。

你项目里一条记录长这样(WebPaint):
// key = "current"
// value =
{ name: "current", updatedAt: 1720000000, ora: Blob(...), thumb: Blob(...) }
ora 就是整个 .ora 画作文件的二进制 Blob,thumb 是缩略图 Blob。"一个 session = 一条记录 = 一次原子写"——一次事务写整包,避免写一半崩溃丢半张画。

4. Transaction(事务) — IDB 所有读写都在事务里,保证原子性:
const tx = db.transaction("sessions", "readwrite");
tx.objectStore("sessions").put(pkg, "current");   // put(value, key)
"readonly" / "readwrite" 两种模式。事务要么整体成功要么整体回滚——你项目注释里"要么全有要么全无"就是靠这个。

5. Index(索引) — 可选,让你按 value 里某个字段查(类似 SQL 的二级索引)。你项目目前没怎么用,都是直接按 key(name)取,所以可以先不管。

为什么用 IDB 而不是 localStorage 存画:画是几 MB 的二进制,localStorage 只能存字符串(要 base64 膨胀 33% 且同步阻塞),IDB 能直接存 Blob 且异步不卡界面。反过来,几十字节的 etag/dirty 标志用 IDB 太重,localStorage 更顺手。所以你项目是"大二进制进 IDB,小元数据进 localStorage"——这是标准分工。

四、把你项目的存储画成一张图

浏览器 origin (webpaint 这个域)
│
├─ localStorage(字符串键值,小元数据)
│   ├─ webpaint.etag:<画名>     云版本号
│   ├─ webpaint.dirty:<画名>    "1"/"0" 有没有未推编辑
│   ├─ webpaint.theme / .lang    设备偏好
│   ├─ webpaint.currentSessionName  当前打开哪张(运行时指针)
│   └─ …(约 23 个散落设置键)
│
└─ IndexedDB
└─ Database "webpaint" (v2)
    ├─ Object Store "sessions"
    │    ├─ "current"               → {name,updatedAt,ora:Blob,thumb}  ← 当前画
    │    ├─ "trash:…:画名"          → 同结构                         ← 回收站
    │    └─ ".backup-local/…:画名"  → 同结构                         ← 覆盖前留底
    └─ Object Store "meta"
          ├─ "brush-rack"            → 笔架预设 JSON
          └─ cloud-thumb:* / revert:* → 缩略缓存 / checkpoint

对照 JRP:同样的分工,只是名字不同——库叫 sync-store-cache、仓叫 blobs、二进制字段叫 blob(WebPaint 叫 ora)。结构一模一样,纯改名(这正是你上一个问题里"能不能靠对齐名字免迁移"的基础:内容盲的 IDB 层对它只是"一个 name 键着一个 Blob",不管里面是画还是 PDF)。

五、几个容易踩的点

- localStorage 同步阻塞:别在热路径(每帧、每笔)里读写,会卡。偏好这种低频的才放它。
- IDB 是异步的:所有操作返回事件/Promise,await 或回调,拿不到"立刻返回的值"。
- 配额驱逐:浏览器空间紧张会整个清掉你的 IDB/Cache(尤其 iOS 装到主屏的 PWA)。所以"只在本地、没上云的脏数据"永远有丢失风险——你项目的红线(dirty 永不被驱逐、脏字节先备份)就是在对抗这个。
- 版本号只增不减:IDB 的 onupgradeneeded 只在版本号变大时跑,是你改 store 结构的唯一窗口。
- key vs value 里的字段:记录的 key(比如画名)和 value 对象里的字段(ora/thumb)是两回事——WebPaint 的 value 里还冗余存了一份 name,其实 key 已经是 name 了。

需要的话,我可以把 Cache Storage(Service Worker 那套离线缓存)也展开讲——它和 IDB 是 PWA 离线的两条腿,常配合用。