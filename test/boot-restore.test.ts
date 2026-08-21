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
    // 崩溃环断路器（纪律③）：默认无标记；marker 探针模拟持久层
    getRestoreAttempt: () => marker,
    setRestoreAttempt: (n) => { marker = n; log.push(`marker=${n}`); },
    flushMarker: async () => { log.push("flushMarker"); },
    onCrashLoopSkipped: (n) => log.push(`crashLoopSkipped(${n})`),
    // 双实例互认（纪律④）：默认无别的窗口持锁（= 无 Web Locks 环境的降级值，行为同旧）
    isDocLockedElsewhere: async () => false,
    onLockedElsewhere: (n) => log.push(`lockedElsewhere(${n})`),
    // 云端功能开关（2026-08-21）：默认开（= 现状行为）
    isCloudEnabled: () => true,
    openBlankCanvas: async () => { log.push("openBlankCanvas"); },
    ...over,
  };
  let marker: string | null = over.getRestoreAttempt ? over.getRestoreAttempt() : null;
  return { p, log, mem: () => memName, marker: () => marker };
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
  let marker: string | null = null;
  const log: string[] = [];
  const p: RestorePorts = {
    getWantedName: () => persisted,
    restore: async () => false,                       // 取消密码框 / 离线只有云端副本 / 文件锁定
    setNameMemoryOnly: () => { log.push("mem"); },    // 只动内存 —— 绝不碰 persisted
    openGallery: async () => {},
    updateSaveStatus: () => {},
    onOpened: () => {},
    onNotFound: () => {},
    getRestoreAttempt: () => marker,
    setRestoreAttempt: (n) => { marker = n; },        // 断路标记有自己的槽 —— 同样绝不碰 persisted
    flushMarker: async () => {},
    onCrashLoopSkipped: () => {},
    isDocLockedElsewhere: async () => false,
    onLockedElsewhere: () => {},
    isCloudEnabled: () => true,
    openBlankCanvas: async () => {},
  };
  eq(await restoreLastSession(p), "gallery-failed");
  eq(persisted, "X", "★ 持久名还在");
  eq(p.getWantedName(), "X", "★ 下次冷启动仍会尝试打开它（v406-v408 这里连它一起清了，v409 修）");
  assert(log.includes("mem"), "内存名确实被降过（纪律①）");
});

test("失败路径的顺序：先降内存名、再刷徽章、再开图库、最后报错（别先报错后甩人）", async () => {
  const { p, log } = ports({ restore: async () => false });
  await restoreLastSession(p);
  // 前三步 = 断路标记生命周期（纪律③）：写标记 → flush 落盘 → 优雅失败清标记；其后顺序同旧约。
  eq(log.join(" > "), "marker=X > flushMarker > marker=null > setNameMemoryOnly(null) > updateSaveStatus > openGallery > notFound(X)");
});

// ── 纪律③：崩溃环断路器（v0.10.9，「小内存设备开超大文件 OOM 锁死环」案）──────────────

test("★ 标记==想开的画 → 断路：跳过自动开、停图库、restore 根本不被调、标记保留", async () => {
  let restoreCalled = false;
  const { p, log, marker } = ports({
    getRestoreAttempt: () => "X",                       // 上次 boot 死在开 X 的半路
    restore: async () => { restoreCalled = true; return true; },
  });
  eq(await restoreLastSession(p), "gallery-crash-loop");
  eq(restoreCalled, false, "★ 断路的意义就是不再碰那张必死的画");
  assert(log.includes("openGallery"), "停图库（用户至少能进 app 了）");
  assert(log.includes("crashLoopSkipped(X)"), "如实告知为什么没自动开");
  eq(marker(), "X", "标记保留——之后每次 boot 都跳，直到某张画成功打开（setCurrentSessionName 清）");
});

test("★ 正常路：restore 之前必须 先写标记、再 flush 落盘（OOM 比 400ms 防抖快）", async () => {
  const { p, log } = ports();
  await restoreLastSession(p);
  const iMark = log.indexOf("marker=X"), iFlush = log.indexOf("flushMarker"), iOpen = log.indexOf("opened(X)");
  assert(iMark !== -1 && iFlush !== -1, "标记+flush 都发生了");
  assert(iMark < iFlush && iFlush < iOpen, `顺序必须 标记→flush→restore（got: ${log.join(" > ")}）`);
});

test("成功 → 标记清回 null（下次冷启动照常自动开）", async () => {
  const { p, marker } = ports();
  eq(await restoreLastSession(p), "restored");
  eq(marker(), null);
});

test("★ 优雅失败（取消密码/离线）→ 标记也清：断路器不毒化纪律②的瞬态 retry 语义", async () => {
  const { p, marker } = ports({ restore: async () => false });
  eq(await restoreLastSession(p), "gallery-failed");
  eq(marker(), null, "★ 下次冷启动仍会尝试打开它——只有「崩溃」（标记没被清成）才断路");
});

test("陈旧标记 ≠ 想开的画 → 不断路，照常开（换过文档后标记自然失效）", async () => {
  const { p, log } = ports({ getRestoreAttempt: () => "OLD-DEAD-DOC" });
  eq(await restoreLastSession(p), "restored");
  assert(log.includes("opened(X)"), "正常打开");
  assert(log.includes("marker=X"), "标记被覆写成新目标");
});

// ── 纪律④：双实例互认（Web Locks，2026-08-21 双实例案）─────────────────────

test("★ 活锁在场 → 不自动开：停图库、restore 不被调、如实报「另一窗口」而非崩溃", async () => {
  let restoreCalled = false;
  const { p, log, mem } = ports({
    isDocLockedElsewhere: async () => true,
    restore: async () => { restoreCalled = true; return true; },
  });
  eq(await restoreLastSession(p), "gallery-locked-elsewhere");
  eq(restoreCalled, false, "★ 同画双开=本地字节互覆，入口就得拦住");
  eq(mem(), null, "内存名降回 safe default（幽灵路径纪律①同款）");
  assert(log.includes("openGallery"), "停图库");
  assert(log.includes("lockedElsewhere(X)"), "如实告知正在另一个窗口");
  assert(!log.some((l) => l.startsWith("crashLoopSkipped")), "不是崩溃，不报 crashLoop");
});

test("★ 活锁在场 + 崩溃标记在场 → 不判崩溃（断路器误触修复）：标记不写不清、断路器语义不被消耗", async () => {
  // 误触序列：实例 A 冷启动写了 restoreAttempt、还在慢加载（等网络/密码）时用户开实例 B
  //   → B 读到 A 的在途标记。旧逻辑 B 误判崩溃环；有锁互认后：A 活着（持锁）⇒ 不是崩溃。
  let restoreCalled = false;
  const { p, log, marker } = ports({
    isDocLockedElsewhere: async () => true,
    getRestoreAttempt: () => "X",
    restore: async () => { restoreCalled = true; return true; },
  });
  eq(await restoreLastSession(p), "gallery-locked-elsewhere");
  eq(restoreCalled, false);
  assert(!log.some((l) => l.startsWith("crashLoopSkipped")), "★ 有人持锁 = 上个实例活着，不是崩溃");
  assert(!log.some((l) => l.startsWith("marker=")), "标记不写不清——断路器语义原样保留");
  eq(marker(), "X", "A 真死时锁自动释放（Web Locks 语义），下次 boot 无锁+标记在场照常断路");
  assert(log.includes("lockedElsewhere(X)"), "报的是「另一窗口」，不是 crashLoop");
});

test("无锁 + 崩溃标记在场 → 原崩溃断路行为一字不变（真崩溃回归）", async () => {
  let restoreCalled = false;
  const { p, log, marker } = ports({
    isDocLockedElsewhere: async () => false,   // 上个实例真死了：锁已被浏览器自动释放
    getRestoreAttempt: () => "X",
    restore: async () => { restoreCalled = true; return true; },
  });
  eq(await restoreLastSession(p), "gallery-crash-loop");
  eq(restoreCalled, false, "断路：不再碰那张必死的画");
  assert(log.includes("crashLoopSkipped(X)"), "照常报 crashLoop");
  eq(marker(), "X", "标记保留语义不变");
});

// ── 云端功能开关（2026-08-21，cloud-capability 接缝）：关 = 不自动恢复、不落图库、零状态变更 ──

test("★ 云关 → blank-cloud-off：restore/图库都不碰，落空白画布，内存名 safe default", async () => {
  let restoreCalled = false;
  const { p, log, mem } = ports({
    isCloudEnabled: () => false,
    restore: async () => { restoreCalled = true; return true; },
  });
  eq(await restoreLastSession(p), "blank-cloud-off");
  eq(restoreCalled, false, "★ 关闭态压根不去开 store 画");
  assert(!log.includes("openGallery"), "不落图库（gating ①把图库藏了，落过去=死路）");
  assert(log.includes("openBlankCanvas"), "落空白画布路径");
  eq(mem(), null, "内存名降回 safe default（幽灵路径纪律①同款）");
});

test("★ 云关的自愈红线：持久 currentFile 与断路标记一个都不动（关→开下次冷启动照常恢复）", async () => {
  let persisted: string | null = "X";
  const { p, log, marker } = ports({
    isCloudEnabled: () => false,
    getWantedName: () => persisted,
    getRestoreAttempt: () => "STALE-MARKER",   // 陈旧标记也原样保留——本门不消费断路器语义
  });
  eq(await restoreLastSession(p), "blank-cloud-off");
  eq(persisted, "X", "★ 持久名原样");
  eq(marker(), "STALE-MARKER", "★ 断路标记原样（不写不清）");
  assert(!log.some((l) => l.startsWith("marker=")), "标记 setter 没被碰过");
  assert(!log.includes("flushMarker"), "flush 也不发生（没有任何持久写）");
});

test("云开 → 行为与旧约完全一致（默认端口即开，全套旧用例已覆盖；这里钉正常路一条）", async () => {
  const { p, log } = ports();
  eq(await restoreLastSession(p), "restored");
  assert(!log.includes("openBlankCanvas"), "开=不走空白画布门");
});
