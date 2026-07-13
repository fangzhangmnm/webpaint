// 回归：WebPaint 裸 session name `X` ↔ 云端文件 `X.ora`（加密 `X.zip`）的**往返**。
//   cutover 曾 (a) create-store 用 fileName=(n)=>n 恒等、(b) listing 按 c.path（含 .ora）归一
//   → 老云端 `X.ora` 被列成身份 `X.ora`，而 app open 用裸名 `X`、本地缓存/迁移也是裸名 `X` → 对不上
//   → 图库全 cloud-only 0B、打开空白画布（真机 v389 抓到）。此测试锁死双向：
//     · listing 身份 = 裸名（toName 去扩展名），不是云端文件名
//     · pull(裸名) 经 fileName 加回 .ora 命中云端文件
//   node 用真 cloud-sync + listing over mock-provider（此前测试都用裸名 mock，没扩展名 → 漏掉）。
import { test, eq, assert } from "./runner.mjs";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createListing } from "../src/store/listing.ts";

const td = new TextDecoder();
const CTX_ON = { signedIn: true, online: true };
const emptyLocal = { async appKeys(): Promise<string[]> { return []; } };
const cleanHead = { seenBase: (): string | null => null, isDirty: (): boolean => false };

test("[cloud-naming] 云端 X.ora → listing 身份=裸名 X（非 X.ora）+ pull(裸名) 取到内容", async () => {
  const provider = createMockProvider();
  provider._seed("20260528-01.ora", "DRAWING-BYTES");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n + ".ora" });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("20260528-01"), `listing 身份应=裸名 20260528-01，实得 ${JSON.stringify(paths)}`);
  assert(!paths.includes("20260528-01.ora"), "身份绝不含 .ora 扩展名（否则 open 裸名对不上）");

  const pulled = await cloud.pull("20260528-01");
  assert(!!pulled, "pull(裸名) 应经 fileName 加 .ora 命中云端文件（否则 0B/打开空白）");
  eq(td.decode(new Uint8Array(await pulled!.blob.arrayBuffer())), "DRAWING-BYTES");
});

test("[cloud-naming] 云端 X.zip（加密外扩展名）→ listing 身份=裸名 X + pull 经 encFileName 命中", async () => {
  const provider = createMockProvider();
  provider._seed("secret.zip", "CIPHER");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n + ".ora", encFileName: (n: string) => n + ".zip" });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("secret"), `加密文件 listing 身份应=裸名 secret，实得 ${JSON.stringify(paths)}`);

  const pulled = await cloud.pull("secret");
  assert(!!pulled, "pull(裸名) 应经 encFileName 加 .zip 命中");
  eq(td.decode(new Uint8Array(await pulled!.blob.arrayBuffer())), "CIPHER");
});

test("[cloud-naming] 子夹 A/wall.ora → listing 身份=A/wall（保留夹路径、只去扩展名）", async () => {
  const provider = createMockProvider();
  provider._seed("A/wall.ora", "SUBFOLDER-DRAWING");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n + ".ora" });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("A", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("A/wall"), `子夹身份应=A/wall（保留夹、去扩展名），实得 ${JSON.stringify(paths)}`);
});
