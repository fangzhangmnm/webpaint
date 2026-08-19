// Timelapse mp4 打包/回读（纯字节，node 可测）。
//
// mux：内存里的 encoded 样本 → 直接可播的普通 mp4（moov 前置，fastStart:'in-memory'）。
//   时间戳全部现场生成（10fps 虚拟节奏），尾帧 duration=5s 定格。muxer = vendor/mp4-muxer（审计版）。
// demux：读回**自己写的** mp4 的样本表（stsz/stsc/stco/stss + avcC），把样本字节拿回内存续录。
//   只保证读自家产物（唯一写者=上面的 mux）；任何解析失败 throw，由调用方按 spec §3 自愈（止损不重建）。
import { Muxer, ArrayBufferTarget } from "../../../vendor/mp4-muxer/mp4-muxer.mjs";
import { TIMELAPSE_FRAME_US, TIMELAPSE_TAIL_HOLD_US } from "./timelapse-core.ts";

/** 一个 encoded 视频样本（avc format：length-prefixed NALU，VideoEncoder `avc:{format:'avc'}` 的原样输出）。 */
export interface TimelapseSample {
  bytes: Uint8Array;
  key: boolean;
}

/** avcC（AVCDecoderConfigurationRecord）→ WebCodecs codec string："avc1." + profile/compat/level hex。 */
export function avcCodecString(avcC: Uint8Array): string {
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/**
 * motion（可空）+ tail（必有——录制开着就有画布可编）→ 完整 mp4 字节。
 * 每次保存整体 re-mux：mux 是纯容器工作，便宜；数据流最简（无分片外科手术）。
 */
export function muxTimelapse(motion: ReadonlyArray<TimelapseSample>, tail: TimelapseSample,
                             avcC: Uint8Array, width: number, height: number): Uint8Array {
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });
  const meta = { decoderConfig: { codec: avcCodecString(avcC), description: avcC } };
  const all = [...motion, tail];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const isTail = i === all.length - 1;
    muxer.addVideoChunkRaw(s.bytes, s.key ? "key" : "delta", i * TIMELAPSE_FRAME_US,
      isTail ? TIMELAPSE_TAIL_HOLD_US : TIMELAPSE_FRAME_US, i === 0 ? meta : undefined);
  }
  muxer.finalize();
  return new Uint8Array((muxer.target as InstanceType<typeof ArrayBufferTarget>).buffer);
}

// ---- demux（自家 mp4 专用样本表读取） ----

export interface DemuxedTimelapse {
  samples: TimelapseSample[];
  avcC: Uint8Array;
  width: number;
  height: number;
}

const FOURCC = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const U16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const U32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** 在 [start,end) 里找第一个名为 type 的 box，返回 payload 区间；找不到 → null。 */
function findBox(b: Uint8Array, start: number, end: number, type: string): { start: number; end: number } | null {
  let o = start;
  while (o + 8 <= end) {
    let size = U32(b, o);
    const t = FOURCC(b, o + 4);
    let payload = o + 8;
    if (size === 1) {   // largesize（u64；自家文件 <16MB 不会出现，防御性支持低 32 位）
      if (U32(b, o + 8) !== 0) throw new Error("mp4 box >4GB unsupported");
      size = U32(b, o + 12);
      payload = o + 16;
    } else if (size === 0) {
      size = end - o;   // 到容器末尾
    }
    if (size < 8 || o + size > end) throw new Error(`corrupt mp4 box at ${o}`);
    if (t === type) return { start: payload, end: o + size };
    o += size;
  }
  return null;
}

function needBox(b: Uint8Array, r: { start: number; end: number }, type: string): { start: number; end: number } {
  const found = findBox(b, r.start, r.end, type);
  if (!found) throw new Error(`mp4 missing box: ${type}`);
  return found;
}

/**
 * 读回自家 mp4 的全部样本（含尾帧——调用方按 timelapse.json 的 motionSamples 截掉尾帧）。
 * 解析目标：moov/trak/mdia/minf/stbl 的 stsd(avc1→avcC)/stsz/stsc/stco/stss。
 */
export function demuxTimelapse(bytes: Uint8Array): DemuxedTimelapse {
  const whole = { start: 0, end: bytes.length };
  const moov = needBox(bytes, whole, "moov");
  const trak = needBox(bytes, moov, "trak");
  const mdia = needBox(bytes, trak, "mdia");
  const minf = needBox(bytes, mdia, "minf");
  const st = needBox(bytes, minf, "stbl");

  // stsd → avc1 sample entry → avcC + 尺寸
  const stsd = needBox(bytes, st, "stsd");
  const avc1 = needBox(bytes, { start: stsd.start + 8, end: stsd.end }, "avc1");   // 跳 version/flags+entry_count
  const width = U16(bytes, avc1.start + 24);    // sample entry：6 reserved + u16 dref + 16 predefined → w,h
  const height = U16(bytes, avc1.start + 26);
  const avcCBox = needBox(bytes, { start: avc1.start + 78, end: avc1.end }, "avcC");
  const avcC = bytes.slice(avcCBox.start, avcCBox.end);

  // stsz：样本大小
  const stsz = needBox(bytes, st, "stsz");
  const uniform = U32(bytes, stsz.start + 4);
  const count = U32(bytes, stsz.start + 8);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(uniform !== 0 ? uniform : U32(bytes, stsz.start + 12 + i * 4));

  // stsc：chunk→每 chunk 样本数（运行长度表）
  const stsc = needBox(bytes, st, "stsc");
  const stscCount = U32(bytes, stsc.start + 4);
  const stscRuns: Array<{ firstChunk: number; perChunk: number }> = [];
  for (let i = 0; i < stscCount; i++) {
    const o = stsc.start + 8 + i * 12;
    stscRuns.push({ firstChunk: U32(bytes, o), perChunk: U32(bytes, o + 4) });
  }

  // stco / co64：chunk 文件偏移
  const stco = findBox(bytes, st.start, st.end, "stco");
  const co64 = stco ? null : needBox(bytes, st, "co64");
  const chunkCount = U32(bytes, (stco ?? co64!).start + 4);
  const chunkOffsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (stco) chunkOffsets.push(U32(bytes, stco.start + 8 + i * 4));
    else {
      const o = co64!.start + 8 + i * 8;
      if (U32(bytes, o) !== 0) throw new Error("mp4 offset >4GB unsupported");
      chunkOffsets.push(U32(bytes, o + 4));
    }
  }

  // stss：关键帧样本号（1-based）；缺省=全关键帧
  const stss = findBox(bytes, st.start, st.end, "stss");
  const keySet = new Set<number>();
  if (stss) {
    const n = U32(bytes, stss.start + 4);
    for (let i = 0; i < n; i++) keySet.add(U32(bytes, stss.start + 8 + i * 4));
  }

  // 展开：按 stsc 运行长度把样本铺到各 chunk，chunk 内样本连续排布
  const samples: TimelapseSample[] = [];
  let sampleIdx = 0;
  for (let c = 0; c < chunkCount && sampleIdx < count; c++) {
    let perChunk = 1;
    for (const run of stscRuns) if (run.firstChunk <= c + 1) perChunk = run.perChunk; else break;
    let off = chunkOffsets[c];
    for (let k = 0; k < perChunk && sampleIdx < count; k++) {
      const size = sizes[sampleIdx];
      if (off + size > bytes.length) throw new Error("mp4 sample out of range");
      samples.push({ bytes: bytes.slice(off, off + size), key: stss ? keySet.has(sampleIdx + 1) : true });
      off += size;
      sampleIdx++;
    }
  }
  if (sampleIdx !== count) throw new Error(`mp4 sample table mismatch: ${sampleIdx}/${count}`);
  return { samples, avcC, width, height };
}
