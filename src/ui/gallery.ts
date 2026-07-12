// 图库（UI 深化 candidate 1 · 最后一块，最深）。
//
// 这是一个**深模块**：把「图库该长什么样、点了怎么动」整块收进来——渲染（文件夹/文件/回收站
// tiles + 面包屑 + 缩略图懒加载 + 每 tile 菜单）+ 文件管理 intent（改名/移动/删除/删空夹/回收站
// 恢复·永删·清空）。数据解析走 store.list seam（app-store.listGallery，本地⊕云已 merge），
// 展示派生走 gallery-view-model（纯·已测）。
//
// 接缝：**真·画布耦合**的几件事走 session-state 模块（active doc 生命周期 SSoT）——
// session.open（开/拉+adopt+关库）、session.push（载 doc + 编码 + flow.push）、session.unload、
// session.rename、session.exit、session.setName。host 只剩 app 的无系统弹窗 UI
// （signedIn/online/activeName/confirm/input/chooseFolder/status/busy）。其余全在本模块。
// 旧 app.js 的 renderGallery/renderTrashView/_renderBreadcrumb/_renderFolderTile/_hydrateCloudThumb
// （~900 行命令式闭包）= 噪音，整体删除，不保留。

import {
  createApp, defineComponent, reactive, ref, computed, watch, onMounted, onUnmounted, nextTick,
} from "../../vendor/vue/vue.esm-browser.prod.js";
import {
  store as _store,
  watchGalleryFolder, listGalleryTrash,
} from "../app-store.ts";
import { listSessions } from "../session.ts";
import { setMeta } from "../storage.ts";
import { getOrFetchCloudThumb } from "../cloud-thumb-cache.ts";
// 加密（ADR-0012）：tile 锁样式 + 解锁浏览；transform/密码循环全在 store（flow.encrypt/decrypt +
// crypt seam）。图库只做 per-app 的部分：首次设密码双输 UX、活动项预检、明文残留清理、
// 以及把 peek 字节解释成缩略图（enc-thumbs）。
import { ENC_PEEK_MIME } from "../crypto-format.ts";
import { isUnlocked, onLockChange, setPassword } from "../crypto-state.ts";
import { localPeekThumb, decryptCloudPeekThumb, ensureNewPassword, ensureUnlocked } from "../enc-thumbs.ts";
import { copyTargetName } from "../gallery-model.ts";
import { pathFolder, pathBasename, pathJoin } from "../gallery-path.ts";
import { stripSessionExt } from "../config.ts";
import { tileFor, breadcrumb, trashTileFor, humanTime, humanSize } from "./gallery-view-model.ts";
import type { GItem, TrashGItem, CloudFileMeta } from "./gallery-view-model.ts";
import { session } from "../session-state.ts";
import { t } from "../i18n/index.ts";

const LS_FOLDER = "webpaint.galleryFolder";

// ---- 图标（从 app.js 搬来，徽章 4 态 + 文件夹/云）----
const SVG = (inner: string, sw = "2") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  localOnly: SVG('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  cloudOnly: SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  syncedBoth: SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 14 11 16 15 12"/>'),
  dirtyBoth: SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="12" y1="17" x2="12" y2="11"/><polyline points="9 14 12 11 15 14"/>'),
  folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', "1.6"),
  cloudBig: SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>', "1.6"),
  ghost: SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="3" y1="3" x2="21" y2="21"/>'),
  lock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', "1.6"),
};

// 锁态 → 反应式镜像（ThumbCell 解锁后原地重试解密，不靠重建组件）
const _lockState = reactive({ unlocked: isUnlocked() });
onLockChange((u: boolean) => { _lockState.unlocked = u; });

export interface GalleryHost {
  signedIn(): boolean;
  online(): boolean;
  activeName(): string | null;
  confirm(title: string, msg: string): Promise<boolean>;
  input(title: string, def: string, opts?: { placeholder?: string }): Promise<string | null>;
  chooseFolder(title: string, msg: string, options: { label: string; value: string }[]): Promise<string | null>;
  status(msg: string, isError?: boolean): void;
  busy<T>(label: string, fn: () => Promise<T>): Promise<T>;
  // 画布耦合操作已搬到 session-state（session.open/push/unload/rename/exit/setName），不再经 host。
}

// 缩略图格子：本地 blob 直显；纯云端进视口才 byte-range 拉；都无 → 名字首字。
// 对象 URL 生命周期归自己（onUnmounted revoke）——取代旧 _galleryUrls 全局数组手动 revoke。
// 加密：本地加密作品（encName）经 store.readPeek（非交互——批量渲染绝不弹窗伏击）；
// 云端拉回 ENC_PEEK_MIME 密文 → store.decryptPeekBytes。锁定 → 锁 icon
// （点它 emit('unlock', name) → 图库走交互解锁）；解锁 → watch 锁态原地重试。
// 解出的 PNG 只进 objectURL，永不写 IDB。
const ThumbCell = defineComponent({
  name: "ThumbCell",
  props: {
    localThumb: { default: null },
    encName: { type: String, default: null },    // 本地加密作品的 name（走 store.readPeek）
    cloud: { default: null },
    fallback: { type: String, default: "?" },
    alt: { type: String, default: "" },
  },
  emits: ["unlock"],
  setup(props: {
    localThumb: Blob | null;
    encName: string | null;
    cloud: CloudFileMeta | null;
    fallback: string;
    alt: string;
  }) {
    const url = ref<string | null>(null);
    const showCloud = ref(false);
    const locked = ref(false);
    const root = ref<HTMLElement | null>(null);
    let cloudEncBlob: Blob | null = null;        // 云端密文 peek（解锁后原地重解）
    let objUrl: string | null = null;
    let obs: IntersectionObserver | null = null;
    const setBlob = (blob: Blob) => {
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(blob); url.value = objUrl;
    };
    const tryDecrypt = async () => {
      let png: Blob | null = null;
      if (props.encName) png = await localPeekThumb(props.encName);
      else if (cloudEncBlob) png = await decryptCloudPeekThumb(props.alt, cloudEncBlob);
      if (png) { locked.value = false; setBlob(png); }
      else locked.value = true;
    };

    onMounted(() => {
      if (props.localThumb) { setBlob(props.localThumb); return; }
      if (props.encName) { tryDecrypt(); return; }
      if (props.cloud) {
        showCloud.value = true;
        obs = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            obs?.disconnect(); obs = null;
            const c = props.cloud!;   // 闭包外 line 119 `if (props.cloud)` 已守门
            getOrFetchCloudThumb(c.id as string, c.eTag || "", c.size || 0, c["@microsoft.graph.downloadUrl"])
              .then(({ blob }: { blob: Blob }) => {
                showCloud.value = false;
                if (blob && blob.type === ENC_PEEK_MIME) { cloudEncBlob = blob; return tryDecrypt(); }
                setBlob(blob);
              })
              .catch((err: unknown) => console.warn("[gallery] thumb:", err));
          }
        }, { rootMargin: "600px 0px", threshold: 0.01 });
        nextTick(() => { if (obs && root.value) obs.observe(root.value); });
      }
    });
    watch(() => _lockState.unlocked, () => { if (locked.value || props.encName) tryDecrypt(); });
    onUnmounted(() => { obs?.disconnect(); if (objUrl) URL.revokeObjectURL(objUrl); });
    return { url, showCloud, locked, root, ICON, lockedTitle: t("gal.lockedThumb") };
  },
  template: `
    <img v-if="url" class="gallery-tile-thumb" :src="url" :alt="alt" loading="lazy" />
    <div v-else-if="locked" class="gallery-tile-thumb placeholder locked" :title="lockedTitle"
         @click.stop="$emit('unlock', encName || alt)">
      <span style="width:42px;height:42px;display:inline-block" v-html="ICON.lock"></span>
    </div>
    <div v-else class="gallery-tile-thumb placeholder" ref="root">
      <span v-if="showCloud" style="width:48px;height:48px;display:inline-block" v-html="ICON.cloudBig"></span>
      <template v-else>{{ fallback }}</template>
    </div>
  `,
});

function makeGallery(host: GalleryHost) {
  return defineComponent({
    name: "Gallery",
    components: { ThumbCell },
    setup() {
      const view = ref<"files" | "trash">("files");
      const folder = ref<string>(safeFolder());
      const loading = ref(false);
      // 当前文件夹的**单夹**快照（store.watchFolder 已切好片；不再客户端 sliceFolder 全表）。
      const data = reactive<{ files: GItem[]; folderNames: string[] }>({ files: [], folderNames: [] });
      const trash = ref<TrashGItem[]>([]);
      const openMenu = ref<string | null>(null);   // 当前展开的 tile 菜单 key

      function safeFolder() { try { return localStorage.getItem(LS_FOLDER) || ""; } catch { return ""; } }

      // ── watchFolder 订阅（网盘模型）：立即本地帧 + 云端帧同一 cb。换夹 = 退订重订。──
      let _unsub: (() => void) | null = null;
      function subscribe() {
        _unsub?.(); _unsub = null;
        if (view.value !== "files") return;
        loading.value = true;
        _unsub = watchGalleryFolder(folder.value, (snap) => {
          if (snap.path !== folder.value) return;   // 双保险：换夹途中的旧帧丢弃（库内已 sanity-check，此处再挡）
          data.files = snap.items as unknown as GItem[];
          data.folderNames = snap.folderNames;
          loading.value = false;
        });
      }
      async function loadTrash() {
        loading.value = true;
        try { trash.value = await listGalleryTrash() as unknown as TrashGItem[]; }
        finally { loading.value = false; }
      }
      // 对外/内部刷新：files 视图重订阅（重跑本地+云端帧）；trash 视图重载。日常本夹写已由 store notifyFolderOf 即时重画。
      async function reload() { openMenu.value = null; if (view.value === "trash") { _unsub?.(); _unsub = null; await loadTrash(); } else subscribe(); }
      function setFolder(p: string) { folder.value = p || ""; try { localStorage.setItem(LS_FOLDER, folder.value); } catch {} openMenu.value = null; subscribe(); }

      subscribe();                        // 初始订阅当前夹
      onUnmounted(() => { _unsub?.(); _unsub = null; });

      // ---- 派生（纯 view-model；切片已在 store 内完成）----
      const folderTiles = computed(() => data.folderNames.map((fn) => ({ name: fn, path: pathJoin(folder.value, fn) })));
      const fileTiles = computed(() => data.files.map((it) => ({
        item: it,
        t: tileFor(it, { signedIn: host.signedIn(), activeName: host.activeName() }),
      })));
      const trashTiles = computed(() => trash.value.map((it) => ({ item: it, t: trashTileFor(it) })));
      const crumbs = computed(() => breadcrumb(folder.value));
      const isEmpty = computed(() => view.value === "trash"
        ? trashTiles.value.length === 0
        : folderTiles.value.length === 0 && fileTiles.value.length === 0);
      const emptyText = computed(() => view.value === "trash" ? t("gal.empty.trash")
        : folder.value ? t("gal.empty.folder", { f: folder.value }) : t("gal.empty.none"));

      const badgeIcon = (k: string) => (ICON as Record<string, string>)[k] || "";
      const fmtMeta = (t: { time: number; size: number }) => `${humanTime(t.time)} · ${humanSize(t.size)}`;

      // ---- 名字冲突预检（快，无网络放前）----
      async function nameTaken(name: string, alsoCloud: boolean): Promise<string | null> {
        const localNames = new Set((await listSessions()).map((s) => s.name));   // 本地跨夹全量（listSessions 名含夹前缀）
        if (localNames.has(name)) return t("gal.loc.local");
        // 云端只查手上当前夹快照（新建/改名/同夹副本都在当前夹；跨夹 move 的目标夹由 store 的 conflictBehavior:fail 兜底 surface）。
        if (alsoCloud && data.files.some((it) => it.name === name && it.cloud)) return t("gal.loc.cloud");
        return null;
      }

      // ---- intents（文件管理：本模块自管；画布耦合：转 host）----
      const toggleMenu = (key: string) => { openMenu.value = openMenu.value === key ? null : key; };

      async function openTile(item: GItem) {
        openMenu.value = null;
        if (item.name === host.activeName()) { await session.open(item); return; }  // 已是活动 → 关库
        await session.open(item);
        await reload();
      }
      function enterFolder(path: string) { setFolder(path); }

      async function rename(item: GItem) {
        openMenu.value = null;
        const isCloud = !!item.cloud;
        if (item.name === host.activeName()) {
          const nn = await session.rename();
          if (nn && nn !== item.name) host.status(t("gal.st.renamed2", { from: item.name, to: nn }));
          await reload(); return;
        }
        // v267 (user)：重名/失败要 surface。图库屏的状态条(canvas HUD)不可见，故把错误
        //   写进重弹的输入框标题（始终可见）并循环重试，而不是只 setStatus 后默默返回。
        let candidate = item.name;
        let note = "";
        while (true) {
          const input = await host.input(note ? t("gal.dlg.renameNote", { note }) : t("gal.dlg.rename"), candidate, { placeholder: t("gal.ph.newName") });
          if (input == null) { host.status(t("gal.st.cancelled")); return; }
          const trimmed = input.trim();
          if (!trimmed) { candidate = ""; note = t("gal.note.empty"); continue; }
          if (trimmed === item.name) { host.status(t("gal.st.nameUnchanged")); return; }
          // 锁屏从确认即开始，把冲突检查（nameTaken 含云端 listCloudSessionsRecursive 网络往返）
          // 也包进来——否则确认后到锁屏之间有明显空窗（用户：「点了没立刻锁，过一会才锁」）。
          const result = await host.busy<{ taken?: string; ok?: boolean; error?: unknown }>(t("gal.busy.rename", { name: item.name, to: trimmed }), async () => {
            const taken = await nameTaken(trimmed, isCloud);
            if (taken) return { taken };
            try {
              await _store.file(item.name, { isZip: true }).rename(trimmed);   // 云端 move 内含（If-Match）
              host.status(t("gal.st.renamed", { to: trimmed }));
              return { ok: true };
            } catch (e: unknown) { return { error: (e as { message?: unknown })?.message || e }; }
          });
          if (result.taken) { candidate = trimmed; note = t("gal.note.taken", { loc: result.taken }); continue; }
          if (result.error) { candidate = trimmed; note = t("gal.note.fail", { e: String(result.error) }); continue; }
          break;
        }
        await reload();
      }

      async function move(item: GItem) {
        openMenu.value = null;
        const cur = pathFolder(item.name), base = pathBasename(item.name);
        // 网盘模型：只提供「上移到父夹」+「移进当前可见子夹」——用手上已有的单夹数据，**绝不再 poll 全树**。
        const targets: string[] = [];
        if (folder.value) targets.push(pathFolder(folder.value));                 // 父夹（当前非根时；父可能是根 ""）
        for (const fn of data.folderNames) targets.push(pathJoin(folder.value, fn)); // 当前夹的 immediate 子夹
        const sorted = [...new Set(targets)].filter((f) => f !== cur)
          .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
        if (!sorted.length) { host.status(t("gal.st.noOtherFolder")); return; }
        const target = await host.chooseFolder(t("gal.dlg.moveTitle", { base }), t("gal.dlg.moveMsg"),
          sorted.map((f) => ({ label: f === "" ? t("gal.rootFolder") : f, value: f })));
        if (target == null) return;
        const newName = pathJoin(target, base);
        if (newName === item.name) { host.status(t("gal.st.alreadyInFolder")); return; }
        // 碰撞不再由 app 先 list 目标夹预检（原则上不知别夹内容）——直接 move，store 目标占用护栏撞名即抛，UI 拒绝。
        await host.busy(t("gal.busy.move", { base, target: target || t("gal.root") }), async () => {
          try {
            await _store.file(item.name, { isZip: true }).rename(newName);
            if (item.name === host.activeName()) session.setName(newName);
            host.status(t("gal.st.moved", { target: target || t("gal.root") }));
          } catch (e: unknown) {
            if ((e as { name?: string })?.name === "CloudNameCollisionError") host.status(t("gal.st.nameTakenTarget", { loc: "", base }), true);
            else host.status(t("gal.st.moveFail", { e: String((e as { message?: unknown })?.message || e) }), true);
          }
        });
        await reload();
      }

      // 复制项目：源字节 → 新名（同文件夹「<名> 副本」自动去重）。app 层组合 _store.flow.saveAs，
      //   不碰红线 store 内部。源字节走**原始字节**（loadRaw / cloud.pull）原样搬运：
      //   · 加密源 → 拷贝的是同一个加密容器（saveAs→_doPush→_seal 见 plain 已是容器即透传，**无需密码**）；
      //   · 纯云端源（无本地副本）→ cloud.pull 拉原始容器字节（同样原样，不解壳）；
      //   · 明文源 → 明文拷贝。新名是全新身份 → _seal 里 local.get(newName)=null → 当明文文件透传。
      async function copy(item: GItem) {
        openMenu.value = null;
        const isCloud = !!item.cloud;
        const cloudOn = host.signedIn() && host.online();
        await host.busy(t("gal.busy.copy", { base: pathBasename(item.name) }), async () => {
          try {
            // 取源原始字节：有本地副本 → loadRaw（离线可用、不弹密码）；纯云端 → 拉云端原始容器。
            // 取源字节：file.open 本地有读本地、无则拉云（明文；⚠TODO 加密源拷贝会解密，待内容盲 raw-read 原语）。
            const bytes: Blob | null = await _store.file(item.name, { isZip: true }).open();
            if (!bytes) { host.status(t("gal.st.copyNoBytes"), true); return; }
            // 目标名：同文件夹下「<名> 副本」「<名> 副本2」…取首个本地⊕云端都不占用的。源在当前夹 → 用手上单夹快照，不 poll。
            const localNames = new Set((await listSessions()).map((s) => s.name));
            const cloudNames = new Set(data.files.filter((it) => it.cloud).map((it) => it.name));   // 当前夹云端名
            const newName = copyTargetName(item.name, (n: string) => localNames.has(n) || cloudNames.has(n));
            // 写新身份：本地存 + 云端 push（云端 best-effort，离线/失败标未推送，下次 Ctrl+S 续）。
            await _store.file(newName, { isZip: true }).save(bytes, { tryPush: cloudOn });   // 新身份：本地存 + best-effort 推
            host.status(t("gal.st.copied", { name: pathBasename(newName) }));
          } catch (e: unknown) { host.status(t("gal.st.copyFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        });
        await reload();
      }

      async function push(item: GItem) { openMenu.value = null; await session.push(item); await reload(); }
      async function unload(item: GItem) { openMenu.value = null; await session.unload(item); await reload(); }

      // ---- 加密 intent（ADR-0012）。transform 与密码循环都在 store（flow.encrypt/decrypt +
      //   crypt seam：本地+云端字节一起换、If-Match、失败标脏接力收敛、密码验证/记忆）。
      //   图库只剩 per-app 的部分：活动项预检（活动 doc 的内存态/同步 base 正被 session 编排，
      //   图库越过它改字节=竞态）、首次设密码的双输 UX、明文残留清理。
      function _encPrecheck(item: GItem, verb: string): boolean {
        if (item.name === host.activeName()) { host.status(t("gal.st.openActive", { verb }), true); return false; }
        if (!item.local) { host.status(t("gal.st.cloudPullFirst", { verb }), true); return false; }
        return true;
      }
      // store transform 的共同收尾：状态文案 + 残留清理。返回是否成功换体。
      async function _afterSwap(item: GItem, res: { status?: string }, okMsg: string): Promise<boolean> {
        if (res.status === "offline") { host.status(t("gal.st.encNeedOnline"), true); return false; }
        if (res.status === "no-local") { host.status(t("gal.st.noLocalBytes"), true); return false; }
        if (res.status === "locked") { host.status(t("gal.st.cancelledPw"), true); return false; }
        if (res.status === "conflict") { host.status(t("gal.st.encConflict", { name: item.name }), true); }
        else if (res.status === "cloud-deferred") { host.status(t("gal.st.encDeferred", { okMsg }), true); }
        else host.status(okMsg);
        // 旧 etag 的云 thumb 缓存条目立即作废（明文/密文残留都清）
        if (item.cloud?.id) { try { await setMeta(`cloud-thumb:${item.cloud.id}`, null); } catch (_) {} }
        return true;
      }

      async function encryptItem(item: GItem) {
        openMenu.value = null;
        if (!_encPrecheck(item, t("gal.verb.encrypt"))) return;
        // 首次设密码（已解锁则复用统一密码）——放进 crypto-state，flow.encrypt 经 seam 自取
        const pw = await ensureNewPassword();
        if (pw == null) { host.status(t("gal.st.cancelled")); return; }
        setPassword(pw);
        try {
          const res = await _store.file(item.name, { isZip: true }).encrypt({ isOnline: () => host.signedIn() && host.online() });
          if (res.status === "already") { host.status(t("gal.st.alreadyEnc")); return; }
          if (!(await _afterSwap(item, res, t("gal.st.encryptedOk", { name: item.name })))) return;
          // 清明文残留：revert checkpoint（旧内容的明文快照）
          try { await setMeta(`revert:${item.name}:ora`, null); await setMeta(`revert:${item.name}:at`, null); } catch (_) {}
        } catch (e: unknown) { host.status(t("gal.st.encFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        await reload();
      }

      async function decryptItem(item: GItem) {
        openMenu.value = null;
        if (!_encPrecheck(item, t("gal.verb.decrypt"))) return;
        if (!(await host.confirm(t("gal.dlg.decryptTitle", { base: pathBasename(item.name) }),
          t("gal.dlg.decryptMsg")))) return;
        // **解锁在 busy 之前**（flow.decrypt 自带 busy；密码框不能在 busy 里弹→死锁）
        if (!(await ensureUnlocked(item.name))) { host.status(t("gal.st.cancelledPw"), true); return; }
        try {
          const res = await _store.file(item.name, { isZip: true }).decrypt({ isOnline: () => host.signedIn() && host.online() });
          if (res.status === "not-encrypted") { host.status(t("gal.st.notEnc")); return; }
          await _afterSwap(item, res, t("gal.st.decrypted", { name: item.name }));
        } catch (e: unknown) { host.status(t("gal.st.decryptFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        await reload();
      }

      // 锁 icon 点击：解锁（busy 外 ensureUnlocked = prompt + verifyPassword + 记忆；本地/云端 peek 自动路由）
      async function onUnlock(name: string) {
        if (await ensureUnlocked(name)) { host.status(t("gal.st.unlocked")); await reload(); }
      }

      async function del(item: GItem) {
        openMenu.value = null;
        const isActive = item.name === host.activeName();
        const isLocal = !!item.local, isCloud = !!item.cloud;
        const dirty = isLocal && isCloud && !!(item as { dirty?: boolean }).dirty;
        let detail = isLocal && isCloud
          ? (dirty ? t("gal.del.dirtyDetail") : t("gal.del.syncedDetail"))
          : isCloud ? t("gal.del.cloudDetail") : t("gal.del.localDetail");
        if (isActive) detail += t("gal.del.activeSuffix");
        if (!(await host.confirm(t("gal.dlg.delTitle", { name: item.name }), detail))) return;
        await host.busy(t("gal.busy.del", { name: item.name }), async () => {
          try {
            await _store.file(item.name, { isZip: true }).delete();
            if (isActive) await session.exit();
            host.status(t("gal.st.deleted", { name: item.name }));
          } catch (e: unknown) { host.status(t("gal.st.delFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        });
        await reload();
      }

      async function folderDelete(ft: { name: string; path: string }) {
        openMenu.value = null;
        // per-folder 模型下不预知子夹空否 → 直接交 store.deleteFolder：库内「必须空」是红线硬兜底，非空则抛、下面 catch surface。
        if (!host.signedIn() || !host.online()) { host.status(t("gal.st.folderDelNeedLogin"), true); return; }
        // 走 store.flow.deleteFolder：库内强制锁屏 + 「必须空」兜底 + 不吞错（旧版 getItemByPath 没选 folder facet
        //   → item.folder 永远 undefined → 根本没删却照报「已删除」= N9 + 用户「删空夹不可用」）。
        try {
          await _store.deleteFolder(ft.path);
          host.status(t("gal.st.folderDeleted", { name: ft.name }));
        } catch (e: unknown) { host.status(t("gal.st.folderDelFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        await reload();
      }

      async function trashRestore(item: TrashGItem) {
        openMenu.value = null;
        await host.busy(t("gal.busy.restore", { name: item.name }), async () => {
          try {
            const res = await _store.restore({
              trashKey: item.local ? item.local.trashKey : null,
              fromCloud: !!item.cloud,
              cloudItemId: item.cloud ? item.cloud.id : null,
              targetName: item.name,
            });
            const rn = res.name || item.name;
            host.status(rn !== item.name ? t("gal.st.restoredRenamed", { name: rn, orig: item.name }) : t("gal.st.restored", { name: rn }));
          } catch (e: unknown) { host.status(t("gal.st.restoreFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        });
        await reload();
      }

      async function trashPurge(item: TrashGItem) {
        openMenu.value = null;
        if (!(await host.confirm(t("gal.dlg.purgeTitle", { name: item.name }), t("gal.dlg.purgeMsg")))) return;
        await host.busy(t("gal.busy.purge", { name: item.name }), async () => {
          try {
            await _store.purge({ trashKey: item.local ? item.local.trashKey : null, cloudItemId: item.cloud ? item.cloud.id : null });
            host.status(t("gal.st.purged", { name: item.name }));
          } catch (e: unknown) { host.status(t("gal.st.purgeFail", { e: String((e as { message?: unknown })?.message || e) }), true); }
        });
        await reload();
      }

      // scope：清哪一端。"local"=仅本地、"cloud"=仅云端、"both"=两端（API 保留，UI 只暴露前两个按钮）。
      async function emptyTrash(scope: "local" | "cloud" | "both" = "both") {
        const label = scope === "local" ? t("gal.scope.local") : scope === "cloud" ? t("gal.scope.cloud") : t("gal.scope.both");
        if (scope === "cloud" && !(host.signedIn() && host.online())) { host.status(t("gal.st.emptyTrashCloudNeedLogin"), true); return; }
        if (!(await host.confirm(t("gal.dlg.emptyTrashTitle", { label }), t("gal.dlg.emptyTrashMsg", { label })))) return;
        await host.busy(t("gal.busy.emptyTrash", { label }), async () => {
          const res = await _store.emptyTrash({ scope });
          const cloudFails = ((res.failed || []) as Array<{ where?: string }>).filter((f) => f.where !== "local").length;
          if (scope !== "local" && cloudFails) host.status(t("gal.st.emptyTrashCloudFail", { n: cloudFails }), true);
          else if ((res.failed || []).length) host.status(t("gal.st.emptyTrashPartial"), true);
          else host.status(t("gal.st.emptyTrashDone", { label }));
        });
        await reload();
      }

      // i18n 模板标签清单（§5a：t() 在 setup 调，模板引 L.*）。
      const L = {
        loading: t("gal.loading"), folder: t("gal.folder"), emptyFolder: t("gal.emptyFolder"), more: t("gal.more"),
        delEmptyFolder: t("gal.delEmptyFolder"), delFolderNonEmpty: t("gal.delFolderNonEmpty"), encrypted: t("enc.locked.aria"),
        divergedNote: t("gal.divergedNote"), renameKeep: t("gal.renameKeep"), discardToTrash: t("gal.discardToTrash"),
        rename: t("gal.rename"), moveTo: t("gal.moveTo"), copy: t("gal.copy"), pullLocal: t("gal.pullLocal"),
        pushCloud: t("gal.pushCloud"), unloadLocal: t("gal.unloadLocal"), encrypt: t("menu.encrypt"), decrypt: t("menu.decrypt"),
        toTrash: t("gal.toTrash"), deleted: t("gal.deleted"), restore: t("gal.restore"), purge: t("gal.purge"),
      };
      return {
        view, folder, loading, openMenu, isEmpty, emptyText, L,
        folderTiles, fileTiles, trashTiles, crumbs,
        badgeIcon, fmtMeta, ICON, toggleMenu, setFolder, enterFolder,
        openTile, rename, move, copy, push, unload, del, folderDelete, trashRestore, trashPurge, emptyTrash,
        encryptItem, decryptItem, onUnlock,
        reload, setView: (v: "files" | "trash") => { view.value = v; reload(); },
      };
    },
    template: `
      <div class="gallery-breadcrumb" :class="{ hidden: view==='trash' || !folder }" v-if="view!=='trash'">
        <template v-for="(c,i) in crumbs" :key="c.path">
          <span v-if="i>0" class="sep">›</span>
          <button type="button" :class="{ current: c.current }" @click="!c.current && setFolder(c.path)">{{ c.label }}</button>
        </template>
      </div>

      <div class="gallery-grid" v-show="!isEmpty">
        <div v-if="loading" class="gallery-loading">{{ L.loading }}</div>

        <template v-if="view==='files' && !loading">
          <div v-for="ft in folderTiles" :key="'F:'+ft.path" class="gallery-tile folder" @click="enterFolder(ft.path)">
            <div class="gallery-tile-thumb" v-html="ICON.folder"></div>
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="ft.path">{{ ft.name }}</div>
              <div class="gallery-tile-meta">{{ L.folder }}</div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" :aria-label="L.more" @click.stop="toggleMenu('F:'+ft.path)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!=='F:'+ft.path }" @click.stop>
              <button type="button" class="danger" @click="folderDelete(ft)">{{ L.delEmptyFolder }}</button>
            </div>
          </div>

          <div v-for="row in fileTiles" :key="row.t.name" class="gallery-tile" :class="{ active: row.t.isActive }" @click="openTile(row.item)">
            <ThumbCell :local-thumb="row.t.hasLocalThumb ? row.item.local.thumb : null" :enc-name="row.t.encrypted ? row.t.name : null" :cloud="row.t.encrypted ? null : row.t.cloud" :fallback="row.t.displayName.slice(0,1) || '?'" :alt="row.t.name" @unlock="onUnlock" />
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="row.t.fullPath">{{ row.t.displayName }}</div>
              <div class="gallery-tile-meta">
                <span v-if="row.t.encrypted" class="gallery-tile-state-icon enc" :title="L.encrypted" v-html="ICON.lock"></span>
                <span class="gallery-tile-state-icon" :title="row.t.badgeTitle" v-html="badgeIcon(row.t.badge)"></span>
                <span>{{ fmtMeta(row.t) }}</span>
              </div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" :aria-label="L.more" @click.stop="toggleMenu(row.t.name)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!==row.t.name }" @click.stop>
              <template v-if="row.t.ghost">
                <div class="gallery-menu-note">{{ L.divergedNote }}</div>
                <button type="button" @click="rename(row.item)">{{ L.renameKeep }}</button>
                <button type="button" class="danger" @click="del(row.item)">{{ L.discardToTrash }}</button>
              </template>
              <template v-else>
                <button type="button" @click="rename(row.item)">{{ L.rename }}</button>
                <button type="button" @click="move(row.item)">{{ L.moveTo }}</button>
                <button type="button" @click="copy(row.item)">{{ L.copy }}</button>
                <button v-if="row.t.badge==='cloudOnly'" type="button" @click="openTile(row.item)">{{ L.pullLocal }}</button>
                <button v-if="row.t.badge==='localOnly'" type="button" @click="push(row.item)">{{ L.pushCloud }}</button>
                <button v-if="row.t.badge==='dirtyBoth'" type="button" @click="push(row.item)">{{ L.pushCloud }}</button>
                <button v-if="row.item.local && row.item.cloud" type="button" @click="unload(row.item)">{{ L.unloadLocal }}</button>
                <button v-if="row.item.local && !row.t.encrypted" type="button" @click="encryptItem(row.item)">{{ L.encrypt }}</button>
                <button v-if="row.item.local && row.t.encrypted" type="button" @click="decryptItem(row.item)">{{ L.decrypt }}</button>
                <button type="button" class="danger" @click="del(row.item)">{{ L.toTrash }}</button>
              </template>
            </div>
          </div>
        </template>

        <template v-if="view==='trash' && !loading">
          <div v-for="row in trashTiles" :key="row.t.name + row.t.deletedAt" class="gallery-tile">
            <ThumbCell :local-thumb="row.t.hasLocalThumb ? row.item.local.thumb : null" :cloud="row.t.cloud" :fallback="row.t.name.slice(0,1) || '?'" :alt="row.t.name" />
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="row.t.name">{{ row.t.name }}</div>
              <div class="gallery-tile-meta">{{ row.t.source }} · {{ fmtMeta({time: row.t.deletedAt, size: 0}).split(' · ')[0] }} {{ L.deleted }}</div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" :aria-label="L.more" @click.stop="toggleMenu('T:'+row.t.name+row.t.deletedAt)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!=='T:'+row.t.name+row.t.deletedAt }" @click.stop>
              <button type="button" @click="trashRestore(row.item)">{{ L.restore }}</button>
              <button type="button" class="danger" @click="trashPurge(row.item)">{{ L.purge }}</button>
            </div>
          </div>
        </template>
      </div>

      <div class="gallery-empty" v-show="isEmpty && !loading">{{ emptyText }}</div>
    `,
  });
}

export interface GalleryHandle {
  refresh(): void;
  setView(v: "files" | "trash"): void;
  getView(): "files" | "trash";
  setFolder(path: string): void;
  getFolder(): string;
  emptyTrash(scope?: "local" | "cloud" | "both"): void;
  unmount(): void;
}

// 组件 setup 暴露给 handle 的反应式态/方法（Vue mount 返回的 proxy 上读到的子集）。
interface GalleryVM {
  reload(): void;
  setView(v: "files" | "trash"): void;
  view: "files" | "trash";
  setFolder(p: string): void;
  folder: string;
  emptyTrash(scope?: "local" | "cloud" | "both"): void;
}

export function mountGallery(el: HTMLElement, host: GalleryHost): GalleryHandle {
  const app = createApp(makeGallery(host));
  const vm = app.mount(el) as unknown as GalleryVM;
  return {
    refresh: () => vm.reload(),
    setView: (v) => vm.setView(v),
    getView: () => vm.view,
    setFolder: (p) => vm.setFolder(p),
    getFolder: () => vm.folder,
    emptyTrash: (scope) => vm.emptyTrash(scope),
    unmount: () => app.unmount(),
  };
}
