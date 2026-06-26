# Blender Texture Protocol (BTP)

**版本** `1.1.0` · **Wire** `v1`（所有 endpoint 以 `/v1` 开头）

## BTP 是什么

平时在外部工具里改 Blender 贴图，得走一圈：Blender 导出 PNG → 存进文件夹 → 在画板里改 → 存回去 → 回 Blender 重新导入。每改一次来一遍。

BTP 把这圈砍了。它是一个 **Blender 插件 + 一套像 HTTP 的小 API**。你的工具（iPad 画板、PC 参考板、一段脚本）直接对 API 读写贴图，改完一调，贴图**立刻**出现在 Blender 里并自动存进 `.blend`，全程不碰 PNG 文件。

```
你的编辑器  →  BTP 客户端库  →  (HTTP 或 WebRTC)  →  Blender 插件  →  Blender 里的贴图
```

连接有两种，**API 完全一样、换连接不改调用代码**：同机用 localhost HTTP（`http://127.0.0.1:18765`，开箱即用），跨设备用 WebRTC（Blender 面板配对一次）。两种连接细节、安全模型、为什么跨设备非得用 WebRTC——都在文末「连接方式与原理」。

---

## 基本流程

拷 `protocol/v1/` 进项目，只从 `index.js` 引入，然后上传一张贴图走一圈：

```javascript
import { BTPClient, BTPError } from "./vendor/btp/v1/index.js";

const client = new BTPClient();          // 默认连同机 http://127.0.0.1:18765

// 看 Blender 里有哪些贴图，以及用户当前选中哪张
const all      = await client.listTextures();      // 全部 metadata
const selected = await client.getSelection();      // { texture: "T_Body", ... }

// 把一张 PNG 覆盖进某张已有贴图。返回 200 即已生效，无需等"同步"
await client.putTextureData("T_Body", myPngBlob);

// 读回像素确认
const blob = await client.getTextureData("T_Body"); 

// 出错就抓 BTPError，认 .code（机器可读，跨版本稳定）
try {
  await client.getTextureMetadata("nonexistent");
} catch (e) {
  if (e instanceof BTPError && e.code === "texture_not_found") { /* 处理 */ }
}
```

贴图**靠名字识别**（无 UUID，名字进 URL 要 percent-encode）；

写**就是整张覆盖**，不做冲突检测，多人同写谁后写谁赢；

所有写操作用户都能 Ctrl-Z。

---

## API 签名

`BTPClient` 的方法一一对应 9 个 endpoint。下面以客户端方法为准；HTTP 行是底层 endpoint，自己实现客户端时看它。

参数里 `name` 是贴图名，`png` 是 PNG 字节（`Blob` / `Uint8Array`）。所有方法 async，失败抛 `BTPError`（带 `.status` `.code` `.details`）。

### 建立连接

同机直接 new BTPClient()。跨设备要先握手，握手产出一个 fetch 喂给 BTPClient：

connectRemote({ signaling })  ──  与 Blender 配对（Blender 出码、app 应答）
  → { fetch, close(), remoteFingerprint, connectionState, peerConnection }
  signaling：在两端之间搬运配对码的策略。手动粘贴用 ManualSignaling：

ManualSignaling({ offer, onAnswer })
  offer          ── 【输入】Blender 面板生成的连接码（字符串，或返回它的函数）
  onAnswer(code) ── 【输出】BTP 算出响应码后回调你，把 code 给用户粘回 Blender

拿到客户端（与同机唯一的差别是 baseUrl 传 ""）：

```javascript
const { fetch } = await connectRemote({
  signaling: ManualSignaling({ offer: blenderCode, onAnswer: showToUser }),
});
const client = new BTPClient({ baseUrl: "", fetch });   // 之后调用与同机完全一致
```

握手 I/O 就两个：进 = Blender 连接码，出 = 你的响应码。底层步骤见「连接方式与原理」。
（另导出 channelFetch(channel)：已有现成 DataChannel 时直接包成 fetch。）

### 读

```
getScene()  ──  GET /v1/scene
  → { blend_filepath, unit, active_object_name }
    blend_filepath 空串 = 没存过盘；active_object_name 为 null = 没选中物体
```
```
listTextures()  ──  GET /v1/textures
  → TextureMetadata[]          按名字排序，不含 VIEWER / MOVIE 类
```
```
getTextureMetadata(name)  ──  GET /v1/textures/{name}
  → TextureMetadata
  错误：404 texture_not_found
```
```
getTextureData(name)  ──  GET /v1/textures/{name}/data
  → Blob                       Content-Type 反映源格式
  副作用：没 pack 的会先帮它 pack（无损）
  错误：404 texture_not_found
```
```
getSelection()  ──  GET /v1/selection
  → { texture, object, mesh }
    texture：先看 Image Editor 显示的，否则当前材质的激活图像节点，都没有则 null
    object / mesh：v1 恒为 null（给后续版本留位）
```

### 写

所有写操作用户可 Ctrl-Z 撤销。

```
putTextureData(name, png)  ──  PUT /v1/textures/{name}/data
  覆盖已有贴图的像素。请求 Content-Type 必须 image/png
  → TextureMetadata            packed 变 true，分辨率以传入 PNG 为准
  错误：404 texture_not_found（PUT 不创建，新建用 createTexture）
        415（Content-Type 不是 PNG）
```
```
createTexture(name, png)  ──  POST /v1/textures
  新建。底层需 header X-BTP-Name + Content-Type: image/png + PNG body
  → 201, TextureMetadata
  错误：409 name_exists ／ 400 missing_name
```
```
renameTexture(oldName, newName)  ──  POST /v1/textures/{name}/rename
  改名。底层请求体 { "new_name": "..." }
  → TextureMetadata
  错误：409 name_exists（不会自动加 .001，直接拒）／ 404 texture_not_found
```

### 扩展（谨慎用）

```
exec(command, params)  ──  POST /v1/exec
  ad-hoc 命令入口，server 端注册自定义命令，返回由命令决定
  错误：404 unknown_command（details.registered 列出已注册命令）
```
> ⚠ `/v1/exec` 下的命令**不在版本保证内**，随时会变。只做临时扩展，别用它跑核心流程。

### escape hatch

```
client.fetch(method, path, opts)    未封装 endpoint 的直通调用，Coding Agent禁止滥用，使用之前请通报人类
```

---

## TextureMetadata

```typescript
interface TextureMetadata {
  name: string;            // 唯一身份，Blender 保证不重名
  width: number;
  height: number;
  channels: number;        // 1 | 3 | 4
  color_space: string;     // "sRGB" | "Non-Color" | … —— 当字符串透传，别硬编码比对
  is_float: boolean;       // true = 32 位浮点 (HDR)
  alpha_mode: string;      // "STRAIGHT" | "PREMUL" | "CHANNEL_PACKED" | "NONE"
  source: string;          // "FILE" | "GENERATED" | "MOVIE" | "VIEWER" | …
  file_format: string;     // "PNG" | "JPEG" | "OPEN_EXR" | …
  is_dirty: boolean;       // .blend 内有未保存修改
  packed: boolean;         // 像素是否已 pack 进 .blend
}
```
`color_space` 在不同 Blender 版本取值可能不同，**当字符串透传**。协议不暴露 DPI（Blender 图像数据不记，纹理用例下无意义）。

---

## 错误码

status 表大类，`error.code` 表具体原因（认 code，跨版本稳定）。形如 `{ "error": { "code": "...", "message": "...", "details": {} } }`。

`200` 成功 · `201` 创建成功 · `400` 请求格式错 · `404` 不存在 · `409` 重名冲突 · `415` Content-Type 非 PNG · `500` server 内部错。

---

## 连接方式与原理

> 用 BTP 不需要读这节，客户端库都处理好了。要部署、排查连接、或自己实现客户端时再看。

**编码**：JSON 一律 UTF-8 + `application/json; charset=utf-8`；贴图二进制 v1 只支持 PNG；URL 里 `{name}` 一律 percent-encode。

**同机 localhost HTTP**：server 监听 `127.0.0.1:18765`（端口可在插件 Preferences 改），**只绑回环、不暴露局域网**。发 CORS `*`，所以 HTTPS 部署的 app 也能 fetch 它（浏览器把 localhost 当安全来源）。开关在 Preferences。安全上只绑本机，残留风险是同机其它程序也能打这端口——靠"用户主动开启"限制，不加 token。

**跨设备为何必须 WebRTC**：浏览器禁止 HTTPS 页面 `fetch http://<局域网IP>`（mixed-content 限制），同 WiFi 也拦，只有 `127.0.0.1` 在白名单。要让 HTTPS 页面连到无 TLS 证书的设备又不让用户装证书，唯一办法是 WebRTC DataChannel（自带 DTLS 加密）。挡路的是浏览器策略不是 NAT；局域网内能省掉公网服务器，但省不掉 WebRTC 本身。

**WebRTC 配对**（Blender 出码、app 应答）：① 用户在 Blender 面板点 "Open for Another Device" 生成连接码 → ② 粘进 app，app 算出响应码 → ③ 把响应码粘回 Blender 的 "Paste Response from Device" → ④ 连上，之后走的处理流程跟 HTTP 完全相同。整条通道 DTLS 加密；"能把码输进自己设备"本身就是认证，担心中间人可首次核对双方 `remoteFingerprint`。

**计划中（未实现）**：一键 PIN 配对（`ServerSignaling`，省掉来回粘贴）；免重复配对（断线自动重连，仅网络身份变了才重配）。

---

## 改这份文档前请读（写给AI coding agent）

这一节Coding Agent不能改。

本文是人类监督 coding agent 的依据：人读它来判断 agent 对这个代码库的改动对不对、代码库当前是什么、interface，接缝和核心承诺是什么。所以它只有一个命根子——**人能读懂**。它一旦混淆（堆细节、堆术语、重心偏移），人就看不住 agent，本文也就废了。混淆主要从两个方向来：

**一、膨胀。** 把刚被关注的细节越写越细，写到它占的篇幅配不上它的分量；几轮下来重心全偏到角落，整体没法读了。

要求：本文结构固定为「Big Picture → MVP → API 签名 → 技术细节讨论」，每部分篇幅与其重要性成比例，维持这一比例是硬约束。
- 改接口（增删字段、改错误码、改参数）：只改「API 签名」里那个 endpoint 的签名块，加 MVP 示例受影响的那一行。不为单个接口新开解释段、背景或原理。
- 改概念（新增一类资源、换连接机制、改核心语义）：才回三层结构，重写对应层级。需要向人类escalate。
- 想加的散文只服务一个细节、不服务全文：不加。压成签名块里的一行注释，或归入「连接方式与原理」。

**二、自言自语。** 写出只有读过某段背景的人才懂的话——针对某次对话的解释、某个内部代号、某条临时进度、某个用户随口说的特殊术语。对没有那段背景的读者，这就是噪音。

要求：每句话都须对一个没有任何项目背景的读者成立。检验方法是把任意一句单独拎出来——若它暗示了读者应当已经知道某段背景，重写它。
- 使用方用通用说法（「一个绘画 app」而不是某个项目代号），不用读者未必认得的专名。
- 功能状态写「已实现」或「计划中（未实现）」，以及改动的时间戳（yyyymmdd HH:mm）
- 不写「最重要的一条」「最常见的问题」这种相对当下讨论才成立的说法；分量靠结构和位置体现，不靠强调。

**例行规则：** 本文描述「这个库现在是什么、怎么用」，改动记录属于 `CHANGELOG.md`，不进本文。本 README.md 随引擎一起拷，是唯一权威；与代码冲突时说明代码可能漂移，请escalate to human。改动记录不进本文。