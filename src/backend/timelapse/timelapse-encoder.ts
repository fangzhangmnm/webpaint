// WebCodecs VideoEncoder 薄包装（注入槽模式，同 ora.ts 的 setOraLogReporter——backend 禁浏览器词，
// node 测试喂 mock 构造器，真 VideoEncoder 由 shell 在 boot 时注入）。
// 结构化最小类型：不赖 lib.dom 是否带 WebCodecs 声明，跨 TS 版本稳。
import type { TimelapseSample } from "./timelapse-mux.ts";

export interface WPEncodedChunkLike {
  type: "key" | "delta";
  byteLength: number;
  copyTo(dst: Uint8Array): void;
}
export interface WPEncoderMetaLike {
  decoderConfig?: { description?: ArrayBuffer | Uint8Array | DataView };
}
export interface WPVideoEncoderLike {
  configure(cfg: Record<string, unknown>): void;
  encode(frame: unknown, opts?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}
export interface WPVideoEncoderCtor {
  new(init: { output: (chunk: WPEncodedChunkLike, meta?: WPEncoderMetaLike) => void;
              error: (e: unknown) => void }): WPVideoEncoderLike;
  isConfigSupported?(cfg: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

let _encoderCtor: WPVideoEncoderCtor | null =
  (globalThis as unknown as { VideoEncoder?: WPVideoEncoderCtor }).VideoEncoder ?? null;
/** 注入槽（测试 mock / shell boot 显式接线）。 */
export function setTimelapseEncoderCtor(ctor: WPVideoEncoderCtor | null): void { _encoderCtor = ctor; }
export function timelapseEncoderAvailable(): boolean { return _encoderCtor !== null; }

function encoderConfig(width: number, height: number, bitrate: number): Record<string, unknown> {
  return {
    codec: "avc1.640028",            // High@4.0 基准；isConfigSupported 兜底降级由 probe 处理
    width, height, bitrate,
    framerate: 10,                   // 虚拟回放节奏（spec §7）
    avc: { format: "avc" },          // length-prefixed NALU——muxer avcC 依赖，勿改 annexb
    latencyMode: "quality",
  };
}

/** feature-gate：设备到底能不能编（spec §2；不支持 → UI 灰掉，绝不影响画画）。 */
export async function timelapseProbeSupport(width: number, height: number): Promise<boolean> {
  const ctor = _encoderCtor;
  if (!ctor || typeof ctor.isConfigSupported !== "function") return false;
  try {
    const r = await ctor.isConfigSupported(encoderConfig(width, height, 250_000));
    return r?.supported === true;
  } catch { return false; }
}

function chunkToSample(chunk: WPEncodedChunkLike): TimelapseSample {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return { bytes, key: chunk.type === "key" };
}

function metaAvcC(meta: WPEncoderMetaLike | undefined): Uint8Array | null {
  const d = meta?.decoderConfig?.description;
  if (!d) return null;
  if (d instanceof Uint8Array) return new Uint8Array(d);   // copy——来源 buffer 可能被复用
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

/**
 * 运动编码器 M：session 内长驻有状态（状态=参考帧，P 帧便宜的来源），只见运动帧。
 * 错误策略 = spec §3 自愈：编码器炸了标记 dead，调用方停录报 info，绝不波及画画/保存。
 */
export class TimelapseMotionEncoder {
  private enc: WPVideoEncoderLike;
  private pending: TimelapseSample[] = [];
  avcC: Uint8Array | null = null;
  dead: unknown = null;
  private framesSinceKey = 0;

  private readonly forcedKeyInterval: number;

  constructor(width: number, height: number, bitrate: number, forcedKeyInterval: number) {
    this.forcedKeyInterval = forcedKeyInterval;
    const ctor = _encoderCtor;
    if (!ctor) throw new Error("VideoEncoder not available (probe first)");
    this.enc = new ctor({
      output: (chunk, meta) => {
        const c = metaAvcC(meta);
        if (c && !this.avcC) this.avcC = c;
        this.pending.push(chunkToSample(chunk));
      },
      error: (e) => { this.dead = e; },
    });
    this.enc.configure(encoderConfig(width, height, bitrate));
  }

  /** frame = VideoFrame（shell 构造并负责 close）。forceKey：断片重开/冷启动。 */
  encode(frame: unknown, forceKey = false): void {
    if (this.dead) return;
    const key = forceKey || this.framesSinceKey >= this.forcedKeyInterval;
    this.framesSinceKey = key ? 1 : this.framesSinceKey + 1;
    try { this.enc.encode(frame, { keyFrame: key }); } catch (e) { this.dead = e; }
  }

  /** flush 并取走积攒的样本（保存前调；返回后 pending 清空）。 */
  async drain(): Promise<TimelapseSample[]> {
    if (!this.dead) { try { await this.enc.flush(); } catch (e) { this.dead = e; } }
    const out = this.pending;
    this.pending = [];
    return out;
  }

  close(): void { try { this.enc.close(); } catch { /* 已 dead/closed */ } }
}

/**
 * 尾帧编码器 F：一次性、纯函数——当前画布 → 同分辨率高码率单张 IDR，用完即弃。
 * M 从不知道尾帧存在（截尾零漂移的来源，spec §2 双编码器架构）。
 */
export async function encodeTailFrame(frame: unknown, width: number, height: number,
                                      bitrate: number): Promise<{ sample: TimelapseSample; avcC: Uint8Array | null }> {
  const ctor = _encoderCtor;
  if (!ctor) throw new Error("VideoEncoder not available");
  let sample: TimelapseSample | null = null;
  let avcC: Uint8Array | null = null;
  let err: unknown = null;
  const enc = new ctor({
    output: (chunk, meta) => { avcC = metaAvcC(meta) ?? avcC; sample = chunkToSample(chunk); },
    error: (e) => { err = e; },
  });
  try {
    enc.configure(encoderConfig(width, height, bitrate));
    enc.encode(frame, { keyFrame: true });
    await enc.flush();
  } finally {
    try { enc.close(); } catch { /* closed */ }
  }
  if (err) throw err;
  if (!sample) throw new Error("tail encoder produced no chunk");
  return { sample, avcC };
}
