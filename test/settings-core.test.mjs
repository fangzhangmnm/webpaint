// settings 路由核（settings-core.ts）验收：scope 路由 + 旧键一次性迁移 + synced 镜像 + init 拉云折回。
import { describe, it, assert, eq } from "./runner.mjs";
import { createSettings, SETTINGS } from "../src/settings-core.ts";

function mkKv() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k) };
}
function mkSynced() {
  const m = new Map();
  return {
    m, get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k),
    init: async () => {}, flush: async () => {},
  };
}
function mkLs(obj = {}) { return { get: (k) => (k in obj ? obj[k] : null) }; }

describe("settings-core · scope 路由", () => {
  it("local 项：set 只写 local，不碰 synced", () => {
    const local = mkKv(), synced = mkSynced();
    const s = createSettings({ local, synced, ls: mkLs() });
    s.set("pixelGrid", false);
    eq(local.get("pixelGrid"), false);
    eq(synced.get("pixelGrid"), undefined);
    eq(s.get("pixelGrid"), false);
  });

  it("synced 项：set 写 local 镜像 + synced 权威两处", () => {
    const local = mkKv(), synced = mkSynced();
    const s = createSettings({ local, synced, ls: mkLs() });
    s.set("theme", "night");
    eq(local.get("theme"), "night");    // 镜像（同步秒读）
    eq(synced.get("theme"), "night");   // 跨设备权威
    eq(s.get("theme"), "night");
  });

  it("未设 → 返回注册表 default", () => {
    const s = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs() });
    eq(s.get("pressureToSize"), true);
    eq(s.get("longPressPick"), false);
    eq(s.get("pickMode"), "composite");
    eq(s.get("lastSize"), 12);
    eq(s.get("theme"), "auto");
  });

  it("无 syncedSettings（未配 syncedSettingsFileName）→ synced 项退化纯本地", () => {
    const local = mkKv();
    const s = createSettings({ local, synced: undefined, ls: mkLs() });
    s.set("theme", "day");
    eq(local.get("theme"), "day");
    eq(s.get("theme"), "day");
  });
});

describe("settings-core · 旧键一次性迁移", () => {
  it("bool 01：webpaint.pToSize=0 → pressureToSize=false（并落进新后端）", () => {
    const local = mkKv();
    const s = createSettings({ local, synced: mkSynced(), ls: mkLs({ "webpaint.pToSize": "0" }) });
    eq(s.get("pressureToSize"), false);
    eq(local.get("pressureToSize"), false);   // 迁移落盘
  });
  it("bool 01 缺省语义：longPressPick 只有 '1' 为真", () => {
    const s1 = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.longPressPick": "1" }) });
    eq(s1.get("longPressPick"), true);
    const s0 = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.longPressPick": "x" }) });
    eq(s0.get("longPressPick"), false);
  });
  it("数字：webpaint.size=37 → lastSize=37", () => {
    const s = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.size": "37" }) });
    eq(s.get("lastSize"), 37);
  });
  it("JSON blob：webpaint.colorPanel.pos → 解析为对象", () => {
    const s = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.colorPanel.pos": '{"x":10,"y":20}' }) });
    eq(s.get("colorPanelPos").x, 10);
  });
  it("synced 旧 blob：webpaint.synced.theme → theme", () => {
    const s = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.synced": '{"theme":"night","lang":"ja"}' }) });
    eq(s.get("theme"), "night");
    eq(s.get("lang"), "ja");
  });
  it("synced 旧散键兜底：webpaint.theme（blob 缺时）", () => {
    const s = createSettings({ local: mkKv(), synced: mkSynced(), ls: mkLs({ "webpaint.theme": "day" }) });
    eq(s.get("theme"), "day");
  });
  it("迁移只发生一次：迁移后改新值，不被旧键盖回", () => {
    const local = mkKv();
    const s = createSettings({ local, synced: mkSynced(), ls: mkLs({ "webpaint.pixelGrid": "0" }) });
    eq(s.get("pixelGrid"), false);   // 迁移
    s.set("pixelGrid", true);        // 用户改回
    eq(s.get("pixelGrid"), true);    // 不再读旧键
  });
});

describe("settings-core · initSynced 拉云折回", () => {
  it("云端有更新的 theme → 折回本地镜像 + 返回 changed=[theme]", async () => {
    const local = mkKv(), synced = mkSynced();
    local.set("theme", "day");        // 本地镜像旧值
    synced.m.set("theme", "night");   // 云端权威新值（模拟别的设备改的）
    const s = createSettings({ local, synced, ls: mkLs() });
    const changed = await s.initSynced();
    eq(changed.join(","), "theme");
    eq(local.get("theme"), "night");  // 折回镜像
    eq(s.get("theme"), "night");
  });
  it("云端无该项 → 不动本地镜像", async () => {
    const local = mkKv(), synced = mkSynced();
    local.set("theme", "day");
    const s = createSettings({ local, synced, ls: mkLs() });
    const changed = await s.initSynced();
    eq(changed.length, 0);
    eq(s.get("theme"), "day");
  });
  it("云端与本地一致 → 不算 changed", async () => {
    const local = mkKv(), synced = mkSynced();
    local.set("theme", "night"); synced.m.set("theme", "night");
    const s = createSettings({ local, synced, ls: mkLs() });
    eq((await s.initSynced()).length, 0);
  });
  it("无 syncedSettings → initSynced 返回 []", async () => {
    const s = createSettings({ local: mkKv(), synced: undefined, ls: mkLs() });
    eq((await s.initSynced()).length, 0);
  });
});

describe("settings-core · 注册表自洽", () => {
  it("每条 spec 有合法 scope + def 字段", () => {
    for (const [k, v] of Object.entries(SETTINGS)) {
      assert(v.scope === "local" || v.scope === "synced", `${k} scope 非法`);
      assert("def" in v, `${k} 缺 def`);
    }
  });
});
