// 无地本地文件模式的**纯函数**测试（spec ai-docs/20260819-clipboard-and-local-file-spec.md §7）。
// FS Access 句柄读写/picker/launchQueue 是浏览器 API 边界 → 进真机批；
// 但「WeebPaint 痕迹检测」决定原位 vs 导入——判错 = 用有损解读原位覆写别人的 Krita 文件，钉在这里。
import { describe, it, assert } from "./runner.mjs";
import { hasWeebPaintTraces } from "../src/local-file-session.ts";

describe("local-file · WeebPaint 痕迹检测（判错会原位覆写外来 ora）", () => {
  it("我们写的 ora（任一 sidecar/元数据在场）→ 可原位", () => {
    assert(hasWeebPaintTraces({ _wroteWith: "v0.9.24-2026-08-19" }), "wroteWith 元数据");
    assert(hasWeebPaintTraces({ _editorState: {} }), "desk sidecar（新轨）");
    assert(hasWeebPaintTraces({ _weebpaintState: {} }), "旧轨 state.json");
  });
  it("外来 ora（Krita 等，三样全无）→ 走导入，绝不原位", () => {
    assert(!hasWeebPaintTraces({}), "什么都没有");
    assert(!hasWeebPaintTraces({ _wroteWith: null, _editorState: null, _weebpaintState: null }), "显式 null 同判外来");
  });
});
