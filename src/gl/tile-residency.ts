// TileResidency —— 本地 GPU/RAM 驻留安全层深模块（docs/20260614-perf-webgl-memory-clip.md §3 模块 3）。
//
// 与云同步 store（src/store/**）**正交**：store 管整-doc .ora↔云（If-Match/move-aside/.trash）；本模块只管
//   **本地** GPU/RAM 冷层驻留 + 无损压缩备份 + context-loss 恢复。私有命名空间，**绝不写 store 的 .ora**。
//
// ── Slice A（本次，见 plan stateful-gathering-parrot）：备份基建 ──
//   纯增量：只提供 backup/restore/canEvictRaw 原语 + pin/unpin，**不接进 live 渲染、不真驱逐** → 零数据风险。
//   下一 slice 才把它接进 GLDocRenderer/doc.ts：冷层真驱逐 raw + 读前 ensureResident（那才动内存，smoke golden 守）。
//
// ── 红线（MASTER §A，硬）──
//   · 备份**无损**：deflate raw 字节（非有损 PNG——alpha=0 处 RGB 被清零=静默改像素=数据红线）。
//   · **dirty/未备份的 raw 永不驱逐**：canEvictRaw 当且仅当 `backupEpoch === pixels.contentVersion`
//     （备份覆盖当前内容）**且**该层非 pinned —— 即 "evict iff clean ∧ re-fetchable"。
//     任何编辑 bump contentVersion → 备份陈旧 → 拒绝驱逐，直到重新备份。

import type { LayerPixels } from "./tile-pixels.ts";

// ── 压缩 codec（可换 seam；无损、字节精确）──
// tile 原始字节 → 压缩字节 → 原始字节。往返必须**逐字节等价**（红线：无损）。
export interface TileCodec {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

// 恒等 codec：不压缩，只深拷贝。给 node 纯逻辑测（不依赖 CompressionStream 环境）。
export const identityCodec: TileCodec = {
  async compress(b) { return b.slice(); },
  async decompress(b) { return b.slice(); },
};

// 默认 codec：native CompressionStream('deflate') —— 无损、字节精确、零依赖，Safari/Chromium/node 已有
//   （cloud-thumbs.ts 已用 deflate-raw）。冷层备份非热路径（层变冷时才跑），async 无妨。
export const deflateCodec: TileCodec = {
  async compress(bytes) { return streamThrough(new CompressionStream("deflate"), bytes); },
  async decompress(bytes) { return streamThrough(new DecompressionStream("deflate"), bytes); },
};

async function streamThrough(stream: CompressionStream | DecompressionStream, input: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

interface LayerBackup {
  epoch: number;                                       // 备份时的 pixels.contentVersion
  tiles: Array<{ tx: number; ty: number; comp: Uint8Array }>;   // 压缩后的稀疏 tile
}

export class TileResidency {
  private _codec: TileCodec;
  private _backups = new Map<number, LayerBackup>();   // layerId → 压缩备份
  private _pinned = new Set<number>();                 // 活动/热层：永不驱逐候选

  constructor(codec: TileCodec = deflateCodec) {
    this._codec = codec;
  }

  // 热/冷提示：活动层 pin（永不驱逐）；切走时 unpin。
  pin(layerId: number): void { this._pinned.add(layerId); }
  unpin(layerId: number): void { this._pinned.delete(layerId); }
  isPinned(layerId: number): boolean { return this._pinned.has(layerId); }

  hasBackup(layerId: number): boolean { return this._backups.has(layerId); }
  backupEpoch(layerId: number): number | null { return this._backups.get(layerId)?.epoch ?? null; }
  // HUD：所有备份的压缩字节总和。
  backupByteUsage(): number {
    let n = 0;
    for (const b of this._backups.values()) for (const t of b.tiles) n += t.comp.byteLength;
    return n;
  }

  // 建/刷新某层的无损压缩备份。**先同步快照字节 + 记 epoch**，再 async 压缩：
  //   若压缩期间该层被编辑 → contentVersion 越过 epoch → canEvictRaw 会因 epoch≠version 返 false（保守安全）。
  async backupLayer(layerId: number, pixels: LayerPixels): Promise<void> {
    const epoch = pixels.contentVersion;
    const snap: Array<{ tx: number; ty: number; bytes: Uint8Array }> = [];
    pixels.forEachTile((tx, ty, px) => {
      snap.push({ tx, ty, bytes: new Uint8Array(px.subarray(0, px.length)) });   // 冻结一份 point-in-time 拷贝
    });
    const tiles: LayerBackup["tiles"] = [];
    for (const { tx, ty, bytes } of snap) tiles.push({ tx, ty, comp: await this._codec.compress(bytes) });
    this._backups.set(layerId, { epoch, tiles });
  }

  // 驱逐门（Slice A 只判定，不真丢 raw；真丢在下一 slice）：
  //   当且仅当 该层有备份 ∧ 备份覆盖当前内容(epoch===contentVersion) ∧ 非 pinned。这是红线的机器可检形式。
  canEvictRaw(layerId: number, pixels: LayerPixels): boolean {
    if (this._pinned.has(layerId)) return false;
    const b = this._backups.get(layerId);
    if (!b) return false;                            // 无完整备份 → 永不驱逐（红线）
    return b.epoch === pixels.contentVersion;         // 备份陈旧（层被编辑过）→ 拒绝
  }

  // 从备份重物化到（被驱逐的）LayerPixels：解压 → adoptResidentTiles（回填 + 清 _evicted 标志 + **不 bump
  //   contentVersion**——内容与备份 epoch 一致，重物化对读者/驱逐门透明）。context-loss recoverAll 用。往返无损。
  async restoreLayer(layerId: number, pixels: LayerPixels): Promise<boolean> {
    const b = this._backups.get(layerId);
    if (!b) return false;
    const entries: Array<{ tx: number; ty: number; px: Uint8ClampedArray }> = [];
    for (const { tx, ty, comp } of b.tiles) {
      const bytes = await this._codec.decompress(comp);
      entries.push({ tx, ty, px: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
    }
    pixels.adoptResidentTiles(entries);
    return true;
  }

  // 删层：丢备份 + unpin（防泄露）。
  dropLayer(layerId: number): void {
    this._backups.delete(layerId);
    this._pinned.delete(layerId);
  }

  // 对账：丢弃所有不在 liveIds 里的层的备份/pin（board 无单独删层钩子 → syncAll 时按当前树对账，防删层泄露备份）。
  forgetExcept(liveIds: Set<number>): void {
    for (const id of [...this._backups.keys()]) if (!liveIds.has(id)) this._backups.delete(id);
    for (const id of [...this._pinned]) if (!liveIds.has(id)) this._pinned.delete(id);
  }
}
