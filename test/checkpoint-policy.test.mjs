// checkpoint（撤销更改 / revert）的**纯策略**测试。
// IDB 那层（storage.ts 的 get/put/deleteCheckpoint）node 测不到 → 进真机批；
// 但「何时封存 / key 怎么拼」这些真正容易搞错的判断是纯的，钉在这里。
import { describe, it, assert, eq } from "./runner.mjs";
import { shouldCapture, checkpointKey, checkpointAgeMinutes } from "../src/checkpoint-policy.ts";

describe("checkpoint · 何时封存（这组判断错了 revert 就废）", () => {
  it("打开一幅画的三个入口 → 封存", () => {
    assert(shouldCapture("gallery-open"), "从图库点开");
    assert(shouldCapture("new-doc"), "新建画布（revert = 回到空白）");
    assert(shouldCapture("save-as"), "另存为新身份");
  });

  it("★冷启动 / tab 重开 → **不**封存", () => {
    // 否则用户重开一次 tab，能回退到的「上次打开」就被刷成了现在，revert 变成空操作。
    assert(!shouldCapture("boot-restore"), "boot-restore 绝不封存");
  });

  it("★revert 自己 → **不**封存", () => {
    // 否则刚回滚掉的状态立刻把快照覆盖了 —— 只能 revert 一次，第二次回到的是回滚后的样子。
    assert(!shouldCapture("revert"), "revert 绝不封存");
  });
});

describe("checkpoint · key 结构", () => {
  it("key = <库身份全名>:<slot>，slot 默认 0", () => {
    eq(checkpointKey("画.ora"), "画.ora:0");
    eq(checkpointKey("画.ora", 0), "画.ora:0");
  });

  it("同一幅画的不同 slot 不撞（现在恒 0，但结构先留好）", () => {
    assert(checkpointKey("A.ora", 0) !== checkpointKey("A.ora", 1), "多档余地");
  });

  it("不同画不撞；带文件夹的全路径也各自独立", () => {
    assert(checkpointKey("A.ora") !== checkpointKey("B.ora"));
    assert(checkpointKey("夹/A.ora") !== checkpointKey("A.ora"), "同名不同夹 = 不同身份");
  });

  it("加密件用的也是**明文全名**（.ora，不带 .zip）→ 加解密来回切不会丢快照", () => {
    // 库对加密件在云端追加 .zip，但 app 侧身份恒是 X.ora；key 跟身份走。
    eq(checkpointKey("画.ora"), "画.ora:0");
  });
});

describe("checkpoint · 年龄显示", () => {
  it("向下不低于 1 分钟（不出现「回到 0 分钟前」这种废话）", () => {
    eq(checkpointAgeMinutes(1000, 1000), 1, "刚封存也显示 1");
    eq(checkpointAgeMinutes(0, 20_000), 1, "20 秒 → 1");
  });
  it("正常四舍五入", () => {
    eq(checkpointAgeMinutes(0, 5 * 60_000), 5);
    eq(checkpointAgeMinutes(0, 90 * 60_000), 90);
  });
});

// （S8 的 makeAutosaveGate 已随 v0.4.11「minIdleMs=30s 空闲触发」退役——节流职责并进 background-sync-jobs.register 的 minIdleMs，测试在 background-sync-jobs.test.mjs。）
