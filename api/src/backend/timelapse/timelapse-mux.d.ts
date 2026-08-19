/** 一个 encoded 视频样本（avc format：length-prefixed NALU，VideoEncoder `avc:{format:'avc'}` 的原样输出）。 */
export interface TimelapseSample {
    bytes: Uint8Array;
    key: boolean;
}
/** avcC（AVCDecoderConfigurationRecord）→ WebCodecs codec string："avc1." + profile/compat/level hex。 */
export declare function avcCodecString(avcC: Uint8Array): string;
/**
 * motion（可空）+ tail（必有——录制开着就有画布可编）→ 完整 mp4 字节。
 * 每次保存整体 re-mux：mux 是纯容器工作，便宜；数据流最简（无分片外科手术）。
 */
export declare function muxTimelapse(motion: ReadonlyArray<TimelapseSample>, tail: TimelapseSample, avcC: Uint8Array, width: number, height: number): Uint8Array;
export interface DemuxedTimelapse {
    samples: TimelapseSample[];
    avcC: Uint8Array;
    width: number;
    height: number;
}
/**
 * 读回自家 mp4 的全部样本（含尾帧——调用方按 timelapse.json 的 motionSamples 截掉尾帧）。
 * 解析目标：moov/trak/mdia/minf/stbl 的 stsd(avc1→avcC)/stsz/stsc/stco/stss。
 */
export declare function demuxTimelapse(bytes: Uint8Array): DemuxedTimelapse;
