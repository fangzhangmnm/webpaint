# jpeg-js（编码半边）

- 来源：npm `jpeg-js@0.4.4` `lib/encoder.js`（BSD-3 Adobe / Andreas Ritter port，LICENSE 同目录）。
- 只 vendor **编码器**：解码走浏览器解码边界（`src/shell/image-io.ts`），不需要 JS 解码器。
- 改动清单在 `jpeg-encoder.mjs` 头注释（ESM 化 / 恒返 Uint8Array / 删 canvas 辅助）。
- 消费接缝 = `src/backend/jpeg-codec.ts`（纯字节，家规「字节进出不走 canvas」）。
- 用途：云盘图片 picker 缩略图（ai-docs/20260820-cloud-image-picker-spec.md §6）。
