// P4（v437）：身份**在赋值处**归一化。
//   sessionFileName 非单射（[\:*?"<>|]+ → "_"、按段 trim、丢空段）。旧版把用户敲的原始名存进
//   _activeSessionName，而 gallery item.name 来自 store（已归一）→ `item.name === activeName`
//   五处比较永久失配。最狠的一处让活动文档改名绕过 es.rename()：盘上改了名、编辑器还指旧身份 →
//   下次 autosave 以 mode:"existing" 把旧身份重建出来 → 两个文件，可见的不是正在编辑的那个。
import { test, eq } from "./runner.mjs";
import { sessionBareName, sessionFileName, stripSessionExt } from "../src/config.ts";

test("sessionFileName ≡ sessionBareName + .ora（归一化只有一个来源）", () => {
  for (const n of ["a:b", "a*b", " a ", "x/y", "", "///", "a__b", "未命名"]) {
    eq(sessionFileName(n), `${sessionBareName(n)}.ora`, `SSoT 一致：${JSON.stringify(n)}`);
  }
});

test("★ 归一化后的名字是不动点：再归一不变（比较才恒等可比）", () => {
  for (const n of ["a:b", "a*b", 'q"w', "a|b", " sp ", "x//y", "", "///", "a?b"]) {
    const once = sessionBareName(n);
    eq(sessionBareName(once), once, `不动点：${JSON.stringify(n)} → ${once}`);
  }
});

test("★ 活动名 ↔ store 身份往返恒等（这正是五处 === 比较依赖的性质）", () => {
  for (const raw of ["a:b", "普通名", "folder/pic", "a*b"]) {
    const active = sessionBareName(raw);                    // app 侧存的（v437 起已归一）
    const fromStore = stripSessionExt(sessionFileName(raw)); // gallery item.name 的来路
    eq(active, fromStore, `往返恒等：${JSON.stringify(raw)}`);
  }
});

test("对照：不归一化就会失配（记录旧 bug 的形状，别再退回去）", () => {
  const raw = "a:b";
  const fromStore = stripSessionExt(sessionFileName(raw));
  eq(fromStore, "a_b", "store 侧是 a_b");
  eq(raw === fromStore, false, "★ 存原始名 → item.name === activeName 永久失配（旧 bug）");
  eq(sessionBareName(raw) === fromStore, true, "归一后恒等");
});
