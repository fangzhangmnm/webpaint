// legacy-bridge（T2）：旧 DocumentOperator 流骑 v2 UndoStack 的唯一栈桥。
// 钉死：run/checkpoint/sealCheckpoint/compound 的旧语义 parity、微步倒序回放、
// compound 失败 = 令牌回滚（含 tiles 混合——fill 形状的原子性）、不可恢复弃栈、onApplied 翻译。
import { describe, it, assert, eq } from "./runner.mjs";
import { UndoStack } from "../src/workpiece/undo-stack.ts";
import { Workpiece, DocumentOperator } from "../src/workpiece/workpiece.ts";
import { LegacyHistory, LegacyOpsComponent } from "../src/workpiece/legacy-bridge.ts";
import { PaintingWorkpiece } from "../src/workpiece/painting-workpiece.ts";
import { LayerPixels } from "../src/tiles/tile-layer.ts";

class SetOp extends DocumentOperator {
  kind = "set";
  forward(w, args, data) {
    const doc = this.mut(w).doc;
    const old = doc.v;
    doc.v = data !== undefined ? data : args.to;
    return { ok: true, replaced: old };
  }
  backward(w, args, data) {
    const doc = this.mut(w).doc;
    const old = doc.v;
    doc.v = data;
    return { ok: true, replaced: old };
  }
  statusFor(dir) { return dir === "undo" ? "撤了set" : undefined; }
}
class FailOp extends SetOp { kind = "fail"; forward() { return { ok: false, msg: "nope" }; } }
class ThrowOp extends SetOp { kind = "throw"; forward() { throw new Error("boom"); } }

function mk(opts = {}) {
  const doc = { v: 0 };
  const ev = { unrecoverable: 0, changes: 0, applied: [] };
  const history = new LegacyHistory({
    maxQuotaBytes: opts.maxQuotaBytes ?? (1 << 30),
    onUnrecoverable: () => { ev.unrecoverable++; },
    onChange: () => { ev.changes++; },
    onApplied: (i) => { ev.applied.push(`${i.dir}:${i.kind}${i.status ? "/" + i.status : ""}`); },
  });
  const w1 = new Workpiece(doc, history);
  const layers = new Map();
  const host = {
    getPixels: (id) => layers.get(id) ?? null,
    findLayerIdByPixels: (lp) => { for (const [id, p] of layers) if (p === lp) return id; return null; },
    eachLayer: (cb) => { for (const [id, p] of layers) cb(id, p); },
    replacePixels: (id, np) => { const old = layers.get(id); layers.set(id, np); old?.dispose(); },
    add: (id) => { const lp = new LayerPixels(64, 64); layers.set(id, lp); return lp; },
    dispose: () => { for (const [, p] of layers) p.dispose(); layers.clear(); },
  };
  const legacy = new LegacyOpsComponent(w1);
  const wp2 = new PaintingWorkpiece({ undo: history.stack, host, legacy, onTokenLeak: () => {} });
  history.attach(wp2, legacy, (on) => wp2.layerTiles._suspendCollect(on));
  return { doc, ev, history, w1, wp2, host };
}

describe("legacy-bridge · run/checkpoint 语义", () => {
  it("standalone run = 一步；undo/redo 沿对称契约往复", () => {
    const { doc, history, w1 } = mk();
    const op = new SetOp();
    eq(history.run(w1, op, { to: 5 }).ok, true);
    eq(doc.v, 5);
    eq(history.depth, 1);
    assert(history.undo(w1)); eq(doc.v, 0);
    assert(history.redo(w1)); eq(doc.v, 5);
    assert(history.undo(w1)); eq(doc.v, 0);
    history.clear();
  });

  it("checkpoint:false 微步流 + sealCheckpoint = 一个整点；undo 一次全回", () => {
    const { doc, history, w1 } = mk();
    const op = new SetOp();
    history.run(w1, op, { to: 1 }, { checkpoint: false });
    history.run(w1, op, { to: 2 }, { checkpoint: false });
    history.run(w1, op, { to: 3 }, { checkpoint: false });
    history.sealCheckpoint();
    eq(history.depth, 1, "三微步一整点");
    history.undo(w1);
    eq(doc.v, 0, "整点一撤到底（倒序回放）");
    history.redo(w1);
    eq(doc.v, 3);
    history.clear();
  });

  it("微步流未封口就 undo → 先补封再撤（旧栈 warning 语义）", () => {
    const { doc, history, w1 } = mk();
    history.run(w1, new SetOp(), { to: 7 }, { checkpoint: false });
    assert(history.undo(w1));
    eq(doc.v, 0);
    history.clear();
  });

  it("run ok:false（op 自行原子回滚）→ 不入栈", () => {
    const { history, w1 } = mk();
    eq(history.run(w1, new FailOp(), { to: 1 }).ok, false);
    eq(history.depth, 0);
    history.clear();
  });

  it("op 抛异常 = 不可恢复：弃整栈 + 回调", () => {
    const { ev, history, w1 } = mk();
    history.run(w1, new SetOp(), { to: 1 });
    eq(history.depth, 1);
    eq(history.run(w1, new ThrowOp(), { to: 2 }).ok, false);
    eq(ev.unrecoverable, 1);
    eq(history.depth, 0, "栈已弃");
    history.clear();
  });
});

describe("legacy-bridge · compound 与混合原子性", () => {
  it("compound 全成 = 一步；中途 throw = 令牌回滚（微步倒序撤干净）", () => {
    const { doc, history, w1 } = mk();
    const op = new SetOp();
    const r = history.compound(w1, () => {
      history.run(w1, op, { to: 1 }, { checkpoint: false });
      history.run(w1, op, { to: 2 }, { checkpoint: false });
      return "val";
    });
    eq(r.ok, true); eq(r.value, "val");
    eq(history.depth, 1);
    const r2 = history.compound(w1, () => {
      history.run(w1, op, { to: 9 }, { checkpoint: false });
      throw new Error("mid fail");
    });
    eq(r2.ok, false);
    eq(doc.v, 2, "失败 compound 的微步已回滚");
    eq(history.depth, 1, "失败不入栈");
    history.clear();
  });

  it("fill 形状：tiles 直写 + legacy 微步同一 compound = 一步；undo 像素/legacy 一体还原", () => {
    const { doc, history, w1, wp2, host } = mk();
    const lp = host.add(1);
    const op = new SetOp();
    const r = history.compound(w1, () => {
      lp.putRegion(0, 0, 4, 4, new Uint8ClampedArray(64).fill(180));   // compound 令牌开着 → collector 收
      history.run(w1, op, { to: 42 }, { checkpoint: false });
    });
    eq(r.ok, true);
    eq(history.depth, 1, "tiles + legacy 打包一步");
    history.undo(w1);
    eq(doc.v, 0, "legacy 侧还原");
    assert(lp.getRegion(0, 0, 8, 8).every((v) => v === 0), "tiles 侧还原");
    history.redo(w1);
    eq(doc.v, 42);
    eq(lp.sampleAt(1, 1)[0], 180);
    history.clear(); host.dispose();
    void wp2;
  });

  it("compound 中途 throw：tiles 写也一体回滚（旧实现做不到的部分）", () => {
    const { history, w1, host } = mk();
    const lp = host.add(1);
    const r = history.compound(w1, () => {
      lp.putRegion(0, 0, 4, 4, new Uint8ClampedArray(64).fill(90));
      throw new Error("bail");
    });
    eq(r.ok, false);
    assert(lp.getRegion(0, 0, 8, 8).every((v) => v === 0), "tiles 回滚无痕");
    eq(history.depth, 0);
    history.clear(); host.dispose();
  });
});

describe("legacy-bridge · 事件翻译", () => {
  it("onApplied：do 即时报；undo/redo 按微步翻译（含 statusFor）；onChange 随栈形变", () => {
    const { ev, history, w1 } = mk();
    history.run(w1, new SetOp(), { to: 3 });
    assert(ev.applied.includes("do:set"), "do 侧即时");
    history.undo(w1);
    assert(ev.applied.some((s) => s.startsWith("undo:set/撤了set")), "undo 翻译带 status");
    history.redo(w1);
    assert(ev.applied.some((s) => s.startsWith("redo:set")));
    assert(ev.changes >= 3, "push/undo/redo 都发 onChange");
    history.clear();
  });

  it("v1 workpiece 跟车：recorded 变更 bump commitVersion + isDirty（app 接线形状）", () => {
    const { history, w1, wp2 } = mk();
    wp2.onChange((e) => { if (e.recorded) w1._bumpCommit(); });
    const v0 = w1.commitVersion;
    w1.isDirty = false;
    history.run(w1, new SetOp(), { to: 1 });
    assert(w1.commitVersion > v0, "commit bump");
    assert(w1.isDirty, "isDirty 置位");
    history.clear();
  });
});
