// 剪贴板/导入**纯策略**测试（spec ai-docs/20260819-clipboard-and-local-file-spec.md）。
// clipboard IO / paste 事件那层 node 测不到 → 进真机批；但双击判窗和护栏阈值是纯的，钉在这里。
import { describe, it, assert, eq } from "./runner.mjs";
import { DOUBLE_COPY_WINDOW_MS, isDoubleCopy, importGuardLimit, needsBigImportSheet } from "../src/clipboard-policy.ts";

describe("clipboard · 双击 Ctrl+C 判窗", () => {
  it("窗口内第二次 → 升级合并复制", () => {
    assert(isDoubleCopy(1000, 1000 + DOUBLE_COPY_WINDOW_MS), "恰好压线算双击");
    assert(isDoubleCopy(1000, 1500), "窗口内");
  });
  it("超窗 / 从未按过 → 不判双", () => {
    assert(!isDoubleCopy(1000, 1000 + DOUBLE_COPY_WINDOW_MS + 1), "超窗 1ms");
    assert(!isDoubleCopy(0, 5), "lastAt=0（从未按过）永不判双——哪怕 now 离 0 很近");
  });
});

describe("import · 大图护栏（错了会重蹈「进门先糊」或护栏失效）", () => {
  it("护栏 = max(2048, 画布长边)", () => {
    eq(importGuardLimit(1024, 768), 2048);
    eq(importGuardLimit(4096, 2048), 4096, "画布 4k → 护栏托到 4k（按 2k 卡 = 进门先糊）");
    eq(importGuardLimit(1000, 3000), 3000, "长边看两个方向");
  });
  it("不超护栏 → 静默原尺寸（不弹窗）", () => {
    assert(!needsBigImportSheet(2048, 2048, 1024, 768), "2k 素材进 1k 画布：比画布大但不超护栏——photobash 常态");
    assert(!needsBigImportSheet(4000, 2000, 4096, 2048), "画布 4k 时 4000px 素材不弹");
  });
  it("任一边超护栏 → 弹「大图片导入」", () => {
    assert(needsBigImportSheet(2049, 100, 1024, 768), "宽超");
    assert(needsBigImportSheet(100, 2049, 1024, 768), "高超");
    assert(needsBigImportSheet(6000, 4000, 1200, 900), "壁纸级素材");
  });
});
