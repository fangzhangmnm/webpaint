// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// safe-resolve（深模块）—— **永不丢字节**地化解本地↔云端分歧。单一职责 = 那条不可重排的顺序：
//   备份先于覆盖(A4/A10) · 采纳前校验真容器(N2,挡 captive-portal HTML) · 采纳后置 etag(R1) ·
//   lost-response 自愈(B5) · 冲突派发(keepMine/takeCloud/cancel)。
// 吃：cloud(pull/weakOverride) + local(backup/save) + local-head(markSynced 落地谱系)。
import { toU8, bytesEqual } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

export type ResolveChoice = "keepMine" | "takeCloud" | "cancel";

export type SafePullResult =
  | { ok: true; backupName?: string }
  | { ok: false; reason: string; backupName?: string; error?: unknown };

type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;

export interface SafeResolveCfg {
  cloud: Pick<CloudSync, "pull" | "weakOverride">;
  local: Pick<LocalCache, "backup" | "save">;
  head: Pick<LocalHead, "isDirty" | "markSynced">;
  localDirty?: () => boolean;                                  // 活动 doc 未落盘（substrate.edits.localDirty）
  // N2 采纳云字节前的校验闸——**必传，无 noop 默认**（store 格式盲，逻辑 app 给）。验的是**解密后的明文**
  //   （库对加密透明）：app 看到的是真 PDF/.ora，不是密文容器。挡 captive-portal HTML / 损坏云副本覆盖好本地。
  validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
  unseal?: (name: string, blob: Blob) => Promise<Blob | null>; // adopt 前解壳（seal 提供）：返明文；加密但锁定 → null。默认明文原样。
  onReplacing?: (on: boolean) => void;                         // N10：换内容临界段 gate（input 起笔门读它降级）
  looksEncrypted?: (bytes: Blob | Bytes) => Promise<boolean>;  // 是否加密容器（weakOverride 扩展名 + 锁定时退验封套）
}

export interface SafeResolve {
  safePull(name: string, opts?: { adopt?: AdoptFn }): Promise<SafePullResult>;
  tryHeal(name: string, bytes: Bytes): Promise<boolean>;
  weakOverride(name: string, bytes: Bytes): Promise<{ backedUp: string | null }>;
  resolveConflict(name: string, choice: ResolveChoice, ctx?: { bytes?: Bytes | null; adopt?: AdoptFn }): Promise<{ status: string; resolution?: string; reason?: string; backupName?: string; backedUp?: string | null }>;
}

export function createSafeResolve(cfg: SafeResolveCfg): SafeResolve {
  const {
    cloud, local, head,
    localDirty = () => false,
    validateAdopt,
    unseal = (_n, blob) => Promise.resolve(blob),
    onReplacing = () => {},
    looksEncrypted = () => Promise.resolve(false),
  } = cfg;

  // 安全拉取覆盖：先 backup（dirty 才备；失败即 abort，绝不 pull/覆盖）→ 拉 → 校验 → 覆盖 → 采纳后置 etag → adopt。
  // 持久态只在原子点改；强退任一 await 点可重入。
  async function safePull(name: string, { adopt }: { adopt?: AdoptFn } = {}): Promise<SafePullResult> {
    onReplacing(true);
    try {
      let backupName: string | undefined;
      // clean 本地 = 可从云重取的已知版本，无未见内容可丢 → 跳 backup（ADR-0016，不 spam .backup）。
      if (head.isDirty(name) || localDirty()) {
        try { backupName = await local.backup(name); }
        catch (e) { return { ok: false, reason: "backup-failed", error: e }; }
      }
      const r = await cloud.pull(name);
      if (!r) return { ok: false, reason: "cloud-vanished", backupName };
      // 库对加密透明：先解密，validateAdopt 验的是**明文**（app 看真 PDF/.ora，不是密文容器）。
      const plain = await unseal(name, r.blob);             // 加密但锁定 → null（无密码解不开）
      // N2：坏字节（captive-portal 200-HTML / 损坏云副本）→ 拒绝，绝不覆盖唯一一份好本地（clean 没 backup）。
      //   锁定解不开 → 退验加密容器封套（captive-portal HTML 不是合法容器；无密码时能做的最强校验）。
      const ok = plain != null ? await validateAdopt(plain) : await looksEncrypted(r.blob);
      if (!ok) return { ok: false, reason: "invalid-cloud-bytes", backupName };
      await local.save(name, r.blob);                       // 覆盖本地（存 at-rest/sealed 字节；dirty 时原件已备份）
      head.markSynced(name, r.item?.eTag ?? null);          // 采纳后置（R1）：etag/dirty 只在 save 成功后推进
      if (adopt && plain != null) await adopt(plain, name); // 复用已解密明文；锁定解不开则只快进落盘、不 adopt
      return { ok: true, backupName };
    } finally {
      onReplacing(false);
    }
  }

  // lost-response 自愈：412 可能是自己已落盘的写。拉云逐字节比对，相等即采纳（B5/W1）。
  async function tryHeal(name: string, bytes: Bytes): Promise<boolean> {
    let pulled;
    try { pulled = await cloud.pull(name); } catch { return false; }
    if (!pulled) return false;
    if (bytesEqual(await toU8(pulled.blob), bytes)) {
      head.markSynced(name, pulled.item?.eTag ?? null);     // 自愈 → 这次推等价已在云端
      return true;
    }
    return false;
  }

  // keepMine：云端→.backup，再 force-push 本地（never-lose 覆盖）。本地胜、loser 进 .backup → 落地为 synced。
  async function weakOverride(name: string, bytes: Bytes): Promise<{ backedUp: string | null }> {
    const r = await cloud.weakOverride(name, bytes, { encrypted: await looksEncrypted(bytes) });
    head.markSynced(name, r.item?.eTag ?? null);
    return { backedUp: r.backedUp };
  }

  // 3 选项派发（README.md §7）：takeCloud=safePull · keepMine=weakOverride · cancel=什么都不动（留 dirty）。
  async function resolveConflict(name: string, choice: ResolveChoice, ctx: { bytes?: Bytes | null; adopt?: AdoptFn } = {}) {
    if (choice === "takeCloud") {
      const r = await safePull(name, { adopt: ctx.adopt });
      return r.ok
        ? { status: "resolved", resolution: "takeCloud", backupName: r.backupName }
        : { status: "unresolved", reason: r.reason, backupName: r.backupName };
    }
    if (choice === "keepMine" && ctx.bytes != null) {
      const r = await weakOverride(name, ctx.bytes);
      return { status: "resolved", resolution: "keepMine", backedUp: r.backedUp };
    }
    return { status: "cancelled" };
  }

  return { safePull, tryHeal, weakOverride, resolveConflict };
}
