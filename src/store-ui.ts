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

  // 冲突必 surface（ADR-0009）：本地 vs 云端二选一（+ 取消）。绝不静默 cancel——引擎强制真 sheet。
  //   注：引擎 ResolveChoice = keepMine|takeCloud|cancel（旧的「keep both/branch」不在此模型，见收敛报告）。
  resolveConflict: async ({ name }): Promise<"keepMine" | "takeCloud" | "cancel"> => {
    const choice = await lockSyncGate<"keepMine" | "takeCloud" | "cancel">({
      title: t("cf.cloudNewerTitle"),
      message: t("cf.conflictBothChanged", { name: stripSessionExt(name) }),

      showSpinner: false,
      actions: [
        { label: t("cf.keepLocal"), value: "keepMine", primary: true },
        { label: t("cf.overwriteLocal"), value: "takeCloud" },
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
