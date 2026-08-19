# mp4-muxer v5.2.2（Vanilagy/mp4-muxer，MIT）

- 上游：github.com/Vanilagy/mp4-muxer @ 0ab3652（2026-08-19 vendored；上游已 deprecated 转 mediabunny——
  选型对比与否决理由见 `ai-docs/20260819-timelapse-spec.md` §6）
- `mp4-muxer.mjs` = 上游 build/ 的未压缩 ESM **原样字节**（未做任何适配）；`mp4-muxer.d.mts` 同源（原名 mp4-muxer.d.ts，改后缀让 tsc bundler 解析认领 .mjs 的类型，内容原样）。
- 源码全文审计 2026-08-19（2316 行 6 文件，红旗零）：审计留档在检疫桶 `~/jupyter/third-party/mp4-muxer/`。
- 消费者：`src/backend/timelapse/`（timelapse mux）。接入约定：VideoEncoder 用 `avc:{format:'avc'}`，
  avcC 走首个 key chunk 的 decoderConfig.description。
