// 零依赖 test runner（spec §5.5：不引 jest/vitest）。
// ESM 模块是单例 → test 文件与 run.mjs 共享同一 _tests 数组。
let _suite = "";
const _tests = [];
const _todos = [];

export function describe(name, fn) { _suite = name; fn(); _suite = ""; }
export function it(name, fn) { _tests.push({ name: `${_suite} › ${name}`, fn }); }
// 家族 store 引擎测试（从 JRP 的 _harness.ts 风格移植）用扁平 test()/tick()——注册进同一 _tests 队列，
// 与 describe/it 共存、同一 run() 执行。import 从 ./_harness.ts 改指 ./runner.mjs 即可。
export function test(name, fn) { _tests.push({ name: `${_suite ? _suite + " › " : ""}${name}`, fn }); }
export function tick() { return new Promise((r) => setTimeout(r, 0)); }
// 待办规格：描述 Store（C1+）必须满足、但当前代码还没实现的行为。
// 不执行、不计失败——是验收标准 / TDD 的红线清单，落地后改成 it() 即可。
export function todo(name) { _todos.push(`${_suite ? _suite + " › " : ""}${name}`); }

export function assert(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }
export function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "不相等"}: 期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}
export async function throwsStatus(fn, status, msg) {
  try { await fn(); }
  catch (e) {
    if (e.status === status) return e;
    throw new Error(`${msg || "错误状态不符"}: 期望 status=${status}，实得 status=${e.status} (${e.message})`);
  }
  throw new Error(`${msg || "应当抛错"}: 期望 status=${status}，但没抛`);
}

export async function run() {
  // C8 测试分级：TEST_FILTER=<子串> 只跑名字匹配的测试（中间棒「只跑相关模块+tsc」的开发期快捷）。
  // 只是过滤器不是分层——交付验收仍跑全量 npm test（+test:full 全量层）；被跳过的文件级收尾
  // （如 shape-brush 的 tile 释放 it）可能一并被跳，FR 泄漏警告刷屏属预期噪音。
  const filter = process.env.TEST_FILTER;
  const tests = filter ? _tests.filter((t) => t.name.includes(filter)) : _tests;
  if (filter) console.log(`\n  TEST_FILTER="${filter}" → ${tests.length}/${_tests.length} 条（开发期快捷，交付仍跑全量）\n`);
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  \x1b[32m✓\x1b[0m", t.name); pass++; }
    catch (e) { console.log("  \x1b[31m✗\x1b[0m", t.name, "\n      ", e.message); fail++; }
  }
  if (_todos.length) {
    console.log("");
    for (const name of _todos) console.log("  \x1b[33m○ todo\x1b[0m", name);
  }
  console.log(`\n  ${pass} passed, ${fail} failed, ${_todos.length} todo\n`);
  if (fail) process.exit(1);
}
