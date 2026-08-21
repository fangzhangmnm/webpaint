// StoreUI adapter —— WeebPaint 给 sync-store 的 ui bundle（createStore 必填 busy/resolveConflict/reportError + 可选 offlineEscape）。
//   cutover：freshness 逻辑进引擎（freshness.ts）后，旧 cloud-freshness.ts 幸存的那点 UI——
//   ① 冲突二选一 sheet（ADR-0009 冲突必 surface）② 「跳过到离线」逃生闸（iOS 老 token fetchMeta 挂死的唯一逃生）
//   ③ 错误 surface——塌进这一个模块。app 只在 app-store 装配时把它传进 createStore。
import type { StoreUI } from "@internal/store";
import { withBusy } from "./fullscreen-busy.ts";
import { lockSyncGate, settleSyncGate } from "./sheets.ts";
import { t } from "./i18n/index.ts";
import { stripSessionExt } from "./config.ts";
import { reportError } from "./error-badge.ts";

export const storeUI: StoreUI = {
  // 用户态写流强制锁屏（可重入 ref-count）。深模块内部 push/rename/del/加密都包这个。
  busy: withBusy,

  // 冲突必 surface（ADR-0009）：绝不静默 cancel——引擎强制真 sheet。
  //   注：引擎 ResolveChoice = keepMine|takeCloud|cancel（旧的「keep both/branch」不在此模型，见收敛报告）。
  //   2026-08-21 grill 拍板：按 occasion 分两套按钮/正文（标题统一「云端有新版本」+ 留底安心小字）——
  //   push（保存 412/撞名）三键：本地覆盖云端(=keepMine 立即强推) / 云端覆盖本地 / 取消；
  //   open（打开时）两键：打开本地(=cancel，暂不解决保存时再裁) / 云端覆盖本地。按钮写实，语义不再漂移。
  resolveConflict: async ({ name, occasion }): Promise<"keepMine" | "takeCloud" | "cancel"> => {
    const n = stripSessionExt(name);
    const choice = occasion === "open"
      ? await lockSyncGate<"cancel" | "takeCloud">({
          title: t("cf.cloudNewerTitle"),
          message: t("cf.body.open", { name: n }),
          note: t("cf.note.keptSafe"),
          showSpinner: false,
          actions: [
            { label: t("cf.act.openLocal"), value: "cancel", primary: true },
            { label: t("cf.act.cloudWins"), value: "takeCloud" },
          ],
        })
      : await lockSyncGate<"keepMine" | "takeCloud" | "cancel">({
          title: t("cf.cloudNewerTitle"),
          message: t("cf.body.push", { name: n }),
          note: t("cf.note.keptSafe"),
          showSpinner: false,
          actions: [
            { label: t("cf.act.localWins"), value: "keepMine", primary: true },
            { label: t("cf.act.cloudWins"), value: "takeCloud" },
            { label: t("common.cancel"), value: "cancel" },
          ],
        });
    return choice ?? "cancel";
  },

  // 错误必 surface（ADR-0009 绝不吞 console）。接统一 error-badge：error/warning→顶层 banner、info→状态栏、log→仅 console。
  reportError: (err: unknown, level): void => { reportError(err, level ?? "error"); },

  // 「跳过到离线」逃生闸（对齐旧 cloud-freshness）：引擎 freshness.open 拿 {probe, settle}，probe 与 fetchMeta race，
  //   finally 调 settle。用户点「跳过到离线」→ probe resolve → 读本地（无硬超时，用户即超时）。
  offlineEscape: (): { probe: Promise<unknown>; settle: () => void } => {
    let onSkip!: () => void;
    const probe = new Promise<unknown>((res) => { onSkip = () => res(undefined); });
    void lockSyncGate<"skip" | null>({
      title: t("cf.checkingCloud"), message: "", showSpinner: true,
      actions: [{ label: t("cf.skipToOffline"), value: "skip" }],
    }).then((v) => { if (v === "skip") onSkip(); });
    return { probe, settle: (): void => settleSyncGate(null) };
  },
};
