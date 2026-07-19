// P5-2（v438）：冷启动恢复的**失败路径**回归。此前零覆盖——没有任何测试 import 过
//   boot.ts / session-state.ts（它们静态 import 了 app-store，模块求值就建 store）。
//   而失败路径上守着两条真纪律，且都是真机最难碰到、最容易被下次重构改掉的部分。
import { test, eq, assert } from "./runner.mjs";
import { restoreLastSession, type RestorePorts } from "../src/boot-restore.ts";

function ports(over: Partial<RestorePorts> = {}) {
  const log: string[] = [];
  let memName: string | null = "PRE-EXISTING";      // 模拟「内存里还留着上一个身份」
  const p: RestorePorts = {
    getWantedName: () => "X",
    restore: async () => true,
    setNameMemoryOnly: (n) => { memName = n; log.push(`setNameMemoryOnly(${n})`); },
    openGallery: async () => { log.push("openGallery"); },
    updateSaveStatus: () => { log.push("updateSaveStatus"); },
    onOpened: (n) => log.push(`opened(${n})`),
    onNotFound: (n) => log.push(`notFound(${n})`),
    ...over,
  };
  return { p, log, mem: () => memName };
}

test("有上次的画且能打开 → restored，不碰图库", async () => {
  const { p, log } = ports();
  eq(await restoreLastSession(p), "restored");
  eq(log.includes("openGallery"), false, "成功就别把用户甩回图库");
  assert(log.includes("opened(X)"), "报「已打开」");
});

test("没有上次的画 → 停图库，且内存名降回 null（别留着上一个身份）", async () => {
  const { p, log, mem } = ports({ getWantedName: () => null });
  eq(await restoreLastSession(p), "gallery-no-name");
  eq(mem(), null, "内存名必须是 safe default");
  assert(log.includes("openGallery"), "停在图库");
});

test("★ 打开失败 → 内存名降回 null（幽灵路径纪律①）", async () => {
  const { p, log, mem } = ports({ restore: async () => false });
  eq(await restoreLastSession(p), "gallery-failed");
  eq(mem(), null, "★ 否则后续 save/rename 会拿「加载失败的 path」当 oldName 去动（AtlasMaker 0.7.2 吃过一个加密文件）");
  assert(log.includes("notFound(X)"), "如实告知没找到");
});

test("★ 打开失败 → 持久的 currentFile 必须还在（纪律②：失败常是瞬态的）", async () => {
  // 真持久层探针：getWantedName 每次都从它读。失败流程里若有任何一处清了它，
  //   第二次 getWantedName 就会变 null —— 而那意味着用户下次冷启动再也开不回这张画。
  let persisted: string | null = "X";
  const log: string[] = [];
  const p: RestorePorts = {
    getWantedName: () => persisted,
    restore: async () => false,                       // 取消密码框 / 离线只有云端副本 / 文件锁定
    setNameMemoryOnly: () => { log.push("mem"); },    // 只动内存 —— 绝不碰 persisted
    openGallery: async () => {},
    updateSaveStatus: () => {},
    onOpened: () => {},
    onNotFound: () => {},
  };
  eq(await restoreLastSession(p), "gallery-failed");
  eq(persisted, "X", "★ 持久名还在");
  eq(p.getWantedName(), "X", "★ 下次冷启动仍会尝试打开它（v406-v408 这里连它一起清了，v409 修）");
  assert(log.includes("mem"), "内存名确实被降过（纪律①）");
});

test("失败路径的顺序：先降内存名、再刷徽章、再开图库、最后报错（别先报错后甩人）", async () => {
  const { p, log } = ports({ restore: async () => false });
  await restoreLastSession(p);
  eq(log.join(" > "), "setNameMemoryOnly(null) > updateSaveStatus > openGallery > notFound(X)");
});
