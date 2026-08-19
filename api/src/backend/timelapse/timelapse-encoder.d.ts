import type { TimelapseSample } from "./timelapse-mux.ts";
export interface WPEncodedChunkLike {
    type: "key" | "delta";
    byteLength: number;
    copyTo(dst: Uint8Array): void;
}
export interface WPEncoderMetaLike {
    decoderConfig?: {
        description?: ArrayBuffer | Uint8Array | DataView;
    };
}
export interface WPVideoEncoderLike {
    configure(cfg: Record<string, unknown>): void;
    encode(frame: unknown, opts?: {
        keyFrame?: boolean;
    }): void;
    flush(): Promise<void>;
    close(): void;
}
export interface WPVideoEncoderCtor {
    new (init: {
        output: (chunk: WPEncodedChunkLike, meta?: WPEncoderMetaLike) => void;
        error: (e: unknown) => void;
    }): WPVideoEncoderLike;
    isConfigSupported?(cfg: Record<string, unknown>): Promise<{
        supported?: boolean;
    }>;
}
/** 注入槽（测试 mock / shell boot 显式接线）。 */
export declare function setTimelapseEncoderCtor(ctor: WPVideoEncoderCtor | null): void;
export declare function timelapseEncoderAvailable(): boolean;
/** feature-gate：设备到底能不能编（spec §2；不支持 → UI 灰掉，绝不影响画画）。 */
export declare function timelapseProbeSupport(width: number, height: number): Promise<boolean>;
/**
 * 运动编码器 M：session 内长驻有状态（状态=参考帧，P 帧便宜的来源），只见运动帧。
 * 错误策略 = spec §3 自愈：编码器炸了标记 dead，调用方停录报 info，绝不波及画画/保存。
 */
export declare class TimelapseMotionEncoder {
    private enc;
    private pending;
    avcC: Uint8Array | null;
    dead: unknown;
    private framesSinceKey;
    private readonly forcedKeyInterval;
    constructor(width: number, height: number, bitrate: number, forcedKeyInterval: number);
    /** frame = VideoFrame（shell 构造并负责 close）。forceKey：断片重开/冷启动。 */
    encode(frame: unknown, forceKey?: boolean): void;
    /** 已编好、还没被 drain 走的样本数（UI「待保存」计数用）。 */
    get pendingCount(): number;
    /** flush 并取走积攒的样本（保存前调；返回后 pending 清空）。 */
    drain(): Promise<TimelapseSample[]>;
    close(): void;
}
/**
 * 尾帧编码器 F：一次性、纯函数——当前画布 → 同分辨率高码率单张 IDR，用完即弃。
 * M 从不知道尾帧存在（截尾零漂移的来源，spec §2 双编码器架构）。
 */
export declare function encodeTailFrame(frame: unknown, width: number, height: number, bitrate: number): Promise<{
    sample: TimelapseSample;
    avcC: Uint8Array | null;
}>;
