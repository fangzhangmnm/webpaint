// drag-value 拖动核纯状态机（v0.7.8）：shift 细调（相对累积、指示器独立于光标）的行为锁。
import { describe, it, eq, assert } from "./runner.mjs";
import { dragBegin, dragMove } from "../src/ui/drag-value.ts";

const R = { left: 0, top: 0, width: 100, height: 100 };   // 1px = 0.01 归一化
const ev = (x, y, shift = false) => ({ clientX: x, clientY: y, shiftKey: shift });
const G = 0.15;

describe("drag-value · 绝对模式（无 shift = 旧行为）", () => {
  it("down 跳到点击处，move 绝对跟手", () => {
    let st = dragBegin(ev(30, 40), R, { x: 0.9, y: 0.9 });
    eq(st.mode, "abs");
    eq(st.x, 0.3); eq(st.y, 0.4);
    st = dragMove(st, ev(70, 20), R, G);
    eq(st.x, 0.7); eq(st.y, 0.2);
  });
  it("越界 clamp 到 [0,1]", () => {
    let st = dragBegin(ev(-10, 250), R, { x: 0.5, y: 0.5 });
    eq(st.x, 0); eq(st.y, 1);
  });
});

describe("drag-value · shift 细调（相对累积）", () => {
  it("shift 起手：从当前值起步，不跳到点击处", () => {
    const st = dragBegin(ev(10, 10, true), R, { x: 0.6, y: 0.7 });
    eq(st.mode, "rel");
    eq(st.x, 0.6); eq(st.y, 0.7);
  });
  it("shift 拖动：值按位移×fineGain 累积（指针动 20px → 值动 20px×0.15）", () => {
    let st = dragBegin(ev(10, 10, true), R, { x: 0.5, y: 0.5 });
    st = dragMove(st, ev(30, 10, true), R, G);
    assert(Math.abs(st.x - (0.5 + 0.2 * G)) < 1e-9, "x 慢速累积");
    eq(st.y, 0.5);
  });
  it("中途按下 shift：abs→rel 无缝切换，值不跳变", () => {
    let st = dragBegin(ev(30, 30), R, { x: 0, y: 0 });        // abs 起手，值=0.3
    st = dragMove(st, ev(50, 30), R, G);                       // abs 拖到 0.5
    eq(st.x, 0.5);
    st = dragMove(st, ev(50, 30, true), R, G);                 // 按下 shift，指针没动
    eq(st.mode, "rel");
    eq(st.x, 0.5, "切换瞬间值不动");
    st = dragMove(st, ev(70, 30, true), R, G);                 // shift 拖 20px
    assert(Math.abs(st.x - (0.5 + 0.2 * G)) < 1e-9, "之后慢速");
  });
  it("中途松开 shift：保持相对模式恢复常速（不跳回光标绝对位置）", () => {
    let st = dragBegin(ev(10, 10, true), R, { x: 0.5, y: 0.5 });
    st = dragMove(st, ev(90, 10, true), R, G);                 // shift 拖 80px → 0.5+0.12=0.62；光标在 0.9
    st = dragMove(st, ev(90, 10, false), R, G);                // 松 shift，指针没动
    assert(Math.abs(st.x - 0.62) < 1e-9, "值不跳到 0.9（指示器独立于光标）");
    st = dragMove(st, ev(80, 10, false), R, G);                // 常速拖 -10px
    assert(Math.abs(st.x - 0.52) < 1e-9, "常速 = 位移 1:1 累积");
  });
  it("相对模式也 clamp", () => {
    let st = dragBegin(ev(10, 10, true), R, { x: 0.98, y: 0 });
    st = dragMove(st, ev(90, 10, false), R, G);                // rel 常速 +0.8 → clamp 1
    eq(st.x, 1);
  });
});
