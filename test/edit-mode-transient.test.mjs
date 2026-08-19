// transient 收口语义钉子（spec ai-docs/20260819-clipboard-and-local-file-spec.md §5）：
// 连贴节奏靠「下一张 Ctrl+V 自动收口悬着的 transform」——import-image.ts:153 走
// applyPendingTransient，这组测试钉死它是 **commit（apply）不是 abort**：收口丢了摆位就是丢画。
import "./dom-shim.mjs";
import { describe, it, assert, eq } from "./runner.mjs";
import { EditMode } from "../src/edit-mode.ts";

function spies() {
  const log = [];
  return { log, hooks: { apply: () => log.push("apply"), abort: () => log.push("abort") } };
}

describe("edit-mode · transient 收口 = commit（连贴自动收口的地基）", () => {
  it("applyPendingTransient → 跑 apply 不跑 abort，回到进场前工具", () => {
    const em = new EditMode({ initialTool: "lasso" });
    const s = spies();
    em.enterTransient("transform", s.hooks);
    assert(em.hasPendingTransient(), "进场后有悬着的 transient");
    em.applyPendingTransient();
    eq(s.log.join(","), "apply", "收口 = apply（commit），绝不是 abort");
    assert(!em.hasPendingTransient(), "收口后 transient 清空");
    eq(em.current(), "lasso", "回到进场前工具");
  });
  it("transient 期再 enterTransient（连贴第二张）→ 旧的先 apply 再进新的", () => {
    const em = new EditMode({ initialTool: "lasso" });
    const s1 = spies(), s2 = spies();
    em.enterTransient("transform", s1.hooks);
    em.enterTransient("transform", s2.hooks);   // 第二张贴进来
    eq(s1.log.join(","), "apply", "旧 transform 被 commit 而非丢弃");
    eq(s2.log.join(","), "", "新 transform 还悬着");
  });
  it("abortTransient → 跑 abort（Esc 语义对照组）", () => {
    const em = new EditMode({ initialTool: "lasso" });
    const s = spies();
    em.enterTransient("transform", s.hooks);
    em.abortTransient();
    eq(s.log.join(","), "abort");
  });
});
