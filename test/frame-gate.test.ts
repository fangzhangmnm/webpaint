// 帧门（gallery 防误触，2026-08-19 user）：手指按住期间列表帧扣住只留最新、抬手+短尾后上屏。
// 守的行为：①门开直通 ②按住只留最新 ③尾巴期间再按下取消开门 ④多指计数 ⑤maxHold 保险丝防冻结
// ⑥up 无配对 down 不越界 ⑦reset 立即开门。
import { test, eq, assert } from "./runner.mjs";
import { createFrameGate, type FrameGateTimers } from "../src/gallery/frame-gate.ts";

// 手拨假时钟：set 记 (fn, 到期时刻)，advance 按到期顺序跑。
function fakeClock() {
  let now = 0, seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: FrameGateTimers = {
    set: (fn, ms) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { due.delete(h as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) { due.delete(id); t.fn(); }
    }
  };
  return { timers, advance };
}

function harness() {
  const clock = fakeClock();
  const applied: string[] = [];
  const gate = createFrameGate<string>((f) => applied.push(f), { timers: clock.timers });
  return { gate, applied, advance: clock.advance };
}

test("门开直通：无按压时 push 立即 apply", () => {
  const { gate, applied } = harness();
  gate.push("A"); gate.push("B");
  eq(applied.join(","), "A,B");
});

test("按住扣帧只留最新：抬手+尾巴后 apply 一次", () => {
  const { gate, applied, advance } = harness();
  gate.pointerDown();
  gate.push("A"); gate.push("B");
  eq(applied.length, 0);
  gate.pointerUp();
  eq(applied.length, 0);          // 尾巴未到，仍持门
  advance(300);
  eq(applied.join(","), "B");     // 只上最新一帧
  gate.push("C");                 // 开门后恢复直通
  eq(applied.join(","), "B,C");
});

test("尾巴期间再按下：取消开门，继续持门", () => {
  const { gate, applied, advance } = harness();
  gate.pointerDown(); gate.push("A"); gate.pointerUp();
  advance(200);                   // 尾巴 300ms 未到
  gate.pointerDown();             // 又按下 → 取消预定开门
  advance(1000);
  eq(applied.length, 0);
  gate.pointerUp(); advance(300);
  eq(applied.join(","), "A");
});

test("多指计数：全部抬起才进入尾巴", () => {
  const { gate, applied, advance } = harness();
  gate.pointerDown(); gate.pointerDown();
  gate.push("A");
  gate.pointerUp(); advance(500); // 还剩一指按着
  eq(applied.length, 0);
  gate.pointerUp(); advance(300);
  eq(applied.join(","), "A");
});

test("maxHold 保险丝：pointerup 丢失也不冻结图库", () => {
  const { gate, applied, advance } = harness();
  gate.pointerDown(); gate.push("A");
  advance(10_000);                // up 从未到达 → 到点强制开门
  eq(applied.join(","), "A");
  gate.push("B");                 // 门已开，直通
  eq(applied.join(","), "A,B");
  assert(!gate.isHeld(), "保险丝后门应为开");
});

test("up 无配对 down：计数钳在 0，后续 down 正常持门", () => {
  const { gate, applied, advance } = harness();
  gate.pointerUp(); gate.pointerUp();
  gate.pointerDown();             // 若越界成负，这里就持不住门
  gate.push("A");
  eq(applied.length, 0);
  gate.pointerUp(); advance(300);
  eq(applied.join(","), "A");
});

test("reset：清计数立即开门，pending 照常 apply", () => {
  const { gate, applied } = harness();
  gate.pointerDown(); gate.push("A");
  gate.reset();
  eq(applied.join(","), "A");
  assert(!gate.isHeld(), "reset 后门应为开");
});
