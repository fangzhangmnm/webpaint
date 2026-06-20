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
  store as _store, isCloudDirty, listCloudSessionsRecursive,
  clearFolderCaches,
  listGallery, listGalleryTrash,
} from "../app-store.js";
import { listSessions } from "../session.ts";
import { setMeta } from "../storage.js";
import { getOrFetchCloudThumb } from "../cloud-thumb-cache.js";
// 加密（ADR-0012）：tile 锁样式 + 解锁浏览；transform/密码循环全在 store（flow.encrypt/decrypt +
// crypt seam）。图库只做 per-app 的部分：首次设密码双输 UX、活动项预检、明文残留清理、
// 以及把 peek 字节解释成缩略图（enc-thumbs）。
import { ENC_PEEK_MIME } from "../crypto-format.js";
import { isUnlocked, onLockChange, setPassword } from "../crypto-state.js";
import { localPeekThumb, decryptCloudPeekThumb, ensureNewPassword, ensureUnlocked } from "../enc-thumbs.js";
import { sliceFolder, folderHasContents, copyTargetName } from "../gallery-model.ts";
import { cloud } from "../app-store.js";
import { pathFolder, pathBasename, pathJoin } from "../gallery-path.ts";
import { stripSessionExt } from "../config.js";
import { tileFor, breadcrumb, trashTileFor, humanTime, humanSize } from "./gallery-view-model.ts";
import type { GItem, TrashGItem, CloudFileMeta } from "./gallery-view-model.ts";
import { session } from "../session-state.ts";

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
    return { url, showCloud, locked, root, ICON };
  },
  template: `
    <img v-if="url" class="gallery-tile-thumb" :src="url" :alt="alt" loading="lazy" />
    <div v-else-if="locked" class="gallery-tile-thumb placeholder locked" title="已加密 —— 点锁解锁预览"
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
      const data = reactive<{ items: GItem[]; cloudFolders: string[] }>({ items: [], cloudFolders: [] });
      const trash = ref<TrashGItem[]>([]);
      const openMenu = ref<string | null>(null);   // 当前展开的 tile 菜单 key

      function safeFolder() { try { return localStorage.getItem(LS_FOLDER) || ""; } catch { return ""; } }
      function setFolder(p: string) { folder.value = p || ""; try { localStorage.setItem(LS_FOLDER, folder.value); } catch {} openMenu.value = null; }

      async function reload() {
        loading.value = true;
        openMenu.value = null;
        try {
          const st = { signedIn: host.signedIn(), online: host.online() };
          if (view.value === "trash") {
            trash.value = await listGalleryTrash(st) as TrashGItem[];
          } else {
            const r = await listGallery(st);
            data.items = r.items; data.cloudFolders = r.cloudFolders;
            if (r.localError) host.status("本地图库读取失败：" + ((r.localError as { message?: unknown }).message || r.localError) + "（隐私窗口 / IDB 被禁？）", true);
          }
        } finally { loading.value = false; }
      }

      // ---- 派生（纯 view-model + gallery-model）----
      const slice = computed(() => sliceFolder(data.items, data.cloudFolders, folder.value));
      const folderTiles = computed(() => slice.value.folderNames.map((fn) => {
        const path = pathJoin(folder.value, fn);
        return { name: fn, path, empty: !folderHasContents(data.items, data.cloudFolders, path) };
      }));
      const fileTiles = computed(() => slice.value.files.map((it) => ({
        item: it,
        t: tileFor(it, { signedIn: host.signedIn(), activeName: host.activeName() }),
      })));
      const trashTiles = computed(() => trash.value.map((it) => ({ item: it, t: trashTileFor(it) })));
      const crumbs = computed(() => breadcrumb(folder.value));
      const isEmpty = computed(() => view.value === "trash"
        ? trashTiles.value.length === 0
        : folderTiles.value.length === 0 && fileTiles.value.length === 0);
      const emptyText = computed(() => view.value === "trash" ? "回收站是空的。"
        : folder.value ? `文件夹 "${folder.value}" 是空的` : "还没有保存的作品。点右上加号新建一个，或先在 PC 上画一笔。");

      const badgeIcon = (k: string) => (ICON as Record<string, string>)[k] || "";
      const fmtMeta = (t: { time: number; size: number }) => `${humanTime(t.time)} · ${humanSize(t.size)}`;

      // ---- 名字冲突预检（快，无网络放前）----
      async function nameTaken(name: string, alsoCloud: boolean): Promise<string | null> {
        const localNames = new Set((await listSessions()).map((s) => s.name));
        if (localNames.has(name)) return "本地";
        if (alsoCloud) {
          try {
            const cloudNames = new Set((await listCloudSessionsRecursive()).map((c: { path: string }) => stripSessionExt(c.path)));
            if (cloudNames.has(name)) return "云端";
          } catch (e) { console.warn("[gallery] cloud names:", e); }
        }
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
          if (nn && nn !== item.name) host.status(`已重命名：${item.name} → ${nn}`);
          await reload(); return;
        }
        // v267 (user)：重名/失败要 surface。图库屏的状态条(canvas HUD)不可见，故把错误
        //   写进重弹的输入框标题（始终可见）并循环重试，而不是只 setStatus 后默默返回。
        let candidate = item.name;
        let note = "";
        while (true) {
          const input = await host.input(note ? `重命名（${note}）` : "重命名", candidate, { placeholder: "新名字" });
          if (input == null) { host.status("已取消"); return; }
          const trimmed = input.trim();
          if (!trimmed) { candidate = ""; note = "名字不能空"; continue; }
          if (trimmed === item.name) { host.status("名字未变"); return; }
          // 锁屏从确认即开始，把冲突检查（nameTaken 含云端 listCloudSessionsRecursive 网络往返）
          // 也包进来——否则确认后到锁屏之间有明显空窗（用户：「点了没立刻锁，过一会才锁」）。
          const result = await host.busy<{ taken?: string; ok?: boolean; error?: unknown }>(`正在重命名 ${item.name} → ${trimmed}…`, async () => {
            const t = await nameTaken(trimmed, isCloud);
            if (t) return { taken: t };
            try {
              const res = await _store.flow.rename(item.name, trimmed, { cloud: isCloud });
              host.status(res.cloudDeferred ? `已重命名（云端稍后重试）：${trimmed}` : `已重命名：${trimmed}`);
              return { ok: true };
            } catch (e: unknown) { return { error: (e as { message?: unknown })?.message || e }; }
          });
          if (result.taken) { candidate = trimmed; note = `${result.taken}已有同名，换一个`; continue; }
          if (result.error) { candidate = trimmed; note = `失败：${result.error}`; continue; }
          break;
        }
        await reload();
      }

      async function move(item: GItem) {
        openMenu.value = null;
        const isCloud = !!item.cloud;
        const cur = pathFolder(item.name), base = pathBasename(item.name);
        const folders = new Set<string>(data.cloudFolders);
        folders.add("");
        for (const it of data.items) {
          const parts = it.name.split("/"); let acc = "";
          for (let i = 0; i < parts.length - 1; i++) { acc = acc ? `${acc}/${parts[i]}` : parts[i]; folders.add(acc); }
        }
        folders.delete(cur);
        const sorted = [...folders].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
        if (!sorted.length) { host.status("没有别的文件夹可移（先新建一个）"); return; }
        const target = await host.chooseFolder(`移动「${base}」到…`, "选择目标文件夹",
          sorted.map((f) => ({ label: f === "" ? "/ 根目录" : f, value: f })));
        if (target == null) return;
        const newName = pathJoin(target, base);
        if (newName === item.name) { host.status("已在该文件夹"); return; }
        const taken = await nameTaken(newName, isCloud);
        if (taken) { host.status(`${taken}目标已有同名「${base}」`, true); return; }
        await host.busy(`正在移动 ${base} → ${target || "根目录"}…`, async () => {
          try {
            const res = await _store.flow.rename(item.name, newName, { cloud: isCloud });
            if (item.name === host.activeName()) session.setName(newName);
            host.status(res.cloudDeferred ? `已移动（云端稍后重试）：${target || "根目录"}` : `已移动到：${target || "根目录"}`);
          } catch (e: unknown) { host.status(`移动失败：${(e as { message?: unknown })?.message || e}`, true); }
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
        await host.busy(`正在创建副本 ${pathBasename(item.name)}…`, async () => {
          try {
            // 取源原始字节：有本地副本 → loadRaw（离线可用、不弹密码）；纯云端 → 拉云端原始容器。
            let bytes: Blob | null = null;
            if (item.local) {
              bytes = await _store.loadRaw(item.name);
            } else if (isCloud) {
              if (!cloudOn) { host.status("纯云端作品复制需先登录并联网", true); return; }
              const r = await cloud.pull(item.name);
              bytes = r ? r.blob : null;
            }
            if (!bytes) { host.status("找不到源作品的字节，复制失败", true); return; }
            // 目标名：同文件夹下「<名> 副本」「<名> 副本2」…取首个本地⊕云端都不占用的。
            const localNames = new Set((await listSessions()).map((s) => s.name));
            let cloudNames = new Set<string>();
            if (cloudOn) {
              try { cloudNames = new Set((await listCloudSessionsRecursive()).map((c: { path: string }) => stripSessionExt(c.path))); }
              catch (e) { console.warn("[gallery] copy cloud names:", e); }
            }
            const newName = copyTargetName(item.name, (n: string) => localNames.has(n) || cloudNames.has(n));
            // 写新身份：本地存 + 云端 push（云端 best-effort，离线/失败标未推送，下次 Ctrl+S 续）。
            const res = await _store.flow.saveAs(newName, { encode: () => bytes, cloud: cloudOn });
            if (!cloudOn) host.status(`已创建副本：${pathBasename(newName)}（仅本地）`);
            else if (res.cloudDeferred) host.status(`已创建副本：${pathBasename(newName)}（本地完成；云端稍后推）`);
            else host.status(`已创建副本：${pathBasename(newName)}`);
          } catch (e: unknown) { host.status(`创建副本失败：${(e as { message?: unknown })?.message || e}`, true); }
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
        if (item.name === host.activeName()) { host.status(`这画正开着 —— 先退出到图库再${verb}`, true); return false; }
        if (!item.local) { host.status(`纯云端作品先拉取到本地再${verb}`, true); return false; }
        return true;
      }
      // store transform 的共同收尾：状态文案 + 残留清理。返回是否成功换体。
      async function _afterSwap(item: GItem, res: { status?: string }, okMsg: string): Promise<boolean> {
        if (res.status === "offline") { host.status(`已同步过云端的作品需在线操作（本地与云端要一起换）`, true); return false; }
        if (res.status === "no-local") { host.status("本地字节缺失", true); return false; }
        if (res.status === "locked") { host.status("已取消（需要密码）", true); return false; }
        if (res.status === "conflict") { host.status(`云端有更新版本：${item.name} —— 本地已换、已标未推送；打开后按冲突流程处理`, true); }
        else if (res.status === "cloud-deferred") { host.status(`${okMsg}（本地完成；云端暂未跟上，已标未推送，回线后推送即同步）`, true); }
        else host.status(okMsg);
        // 旧 etag 的云 thumb 缓存条目立即作废（明文/密文残留都清）
        if (item.cloud?.id) { try { await setMeta(`cloud-thumb:${item.cloud.id}`, null); } catch (_) {} }
        return true;
      }

      async function encryptItem(item: GItem) {
        openMenu.value = null;
        if (!_encPrecheck(item, "加密")) return;
        // 首次设密码（已解锁则复用统一密码）——放进 crypto-state，flow.encrypt 经 seam 自取
        const pw = await ensureNewPassword();
        if (pw == null) { host.status("已取消"); return; }
        setPassword(pw);
        try {
          const res = await _store.flow.encrypt(item.name, { isOnline: () => host.signedIn() && host.online() });
          if (res.status === "already") { host.status("已是加密作品"); return; }
          if (!(await _afterSwap(item, res, `已加密：${item.name}（7-Zip 输此密码可恢复；忘记密码内容永久找不回）`))) return;
          // 清明文残留：revert checkpoint（旧内容的明文快照）
          try { await setMeta(`revert:${item.name}:ora`, null); await setMeta(`revert:${item.name}:at`, null); } catch (_) {}
        } catch (e: unknown) { host.status(`加密失败：${(e as { message?: unknown })?.message || e}`, true); }
        await reload();
      }

      async function decryptItem(item: GItem) {
        openMenu.value = null;
        if (!_encPrecheck(item, "解除加密")) return;
        if (!(await host.confirm(`解除「${pathBasename(item.name)}」的加密？`,
          "内容将以明文存放在本机与云端，任何能访问此设备或云账号的人都能查看。"))) return;
        // **解锁在 busy 之前**（flow.decrypt 自带 busy；密码框不能在 busy 里弹→死锁）
        if (!(await ensureUnlocked(item.name))) { host.status("已取消（需要密码）", true); return; }
        try {
          const res = await _store.flow.decrypt(item.name, { isOnline: () => host.signedIn() && host.online() });
          if (res.status === "not-encrypted") { host.status("这不是加密作品"); return; }
          await _afterSwap(item, res, `已解除加密：${item.name}`);
        } catch (e: unknown) { host.status(`解除加密失败：${(e as { message?: unknown })?.message || e}`, true); }
        await reload();
      }

      // 锁 icon 点击：解锁（busy 外 ensureUnlocked = prompt + verifyPassword + 记忆；本地/云端 peek 自动路由）
      async function onUnlock(name: string) {
        if (await ensureUnlocked(name)) { host.status("已解锁加密作品（密码只在内存，关页即忘）"); await reload(); }
      }

      async function del(item: GItem) {
        openMenu.value = null;
        const isActive = item.name === host.activeName();
        const isLocal = !!item.local, isCloud = !!item.cloud;
        const dirty = isLocal && isCloud && isCloudDirty(item.name);
        let detail = isLocal && isCloud
          ? (dirty ? "本地有**未推送到云端的修改**，删除会丢这些改动。云端备份进回收站可恢复。" : "本地副本会一起删，云端进回收站可恢复。")
          : isCloud ? "会进云端回收站，可恢复。" : "会进本地回收站，可恢复。";
        if (isActive) detail += " 当前画布会关闭。";
        if (!(await host.confirm(`删除 "${item.name}"？`, detail))) return;
        await host.busy(`正在删除 ${item.name}…`, async () => {
          try {
            await _store.flow.delete(item.name, { isOnline: () => host.online() });
            if (isActive) await session.exit();
            host.status(`已删除：${item.name}`);
          } catch (e: unknown) { host.status(`删除失败：${(e as { message?: unknown })?.message || e}`, true); }
        });
        await reload();
      }

      async function folderDelete(ft: { name: string; path: string; empty: boolean }) {
        openMenu.value = null;
        if (!ft.empty) { host.status("文件夹非空，请先把里面的作品移走或删除", true); return; }
        if (!host.signedIn() || !host.online()) { host.status("删除文件夹需先登录云端", true); return; }
        // 走 store.flow.deleteFolder：库内强制锁屏 + 「必须空」兜底 + 不吞错（旧版 getItemByPath 没选 folder facet
        //   → item.folder 永远 undefined → 根本没删却照报「已删除」= N9 + 用户「删空夹不可用」）。
        try {
          const res = await _store.flow.deleteFolder(ft.path, { isOnline: () => host.online() });
          clearFolderCaches();
          host.status(res.status === "folder-deleted" ? `已删除空文件夹：${ft.name}` : `文件夹已不存在：${ft.name}`);
        } catch (e: unknown) { host.status(`删除文件夹失败：${(e as { message?: unknown })?.message || e}`, true); }
        await reload();
      }

      async function trashRestore(item: TrashGItem) {
        openMenu.value = null;
        await host.busy(`正在恢复 ${item.name}…`, async () => {
          try {
            const res = await _store.flow.restore({
              trashKey: item.local ? item.local.trashKey : null,
              fromCloud: !!item.cloud,
              cloudItemId: item.cloud ? item.cloud.id : null,
              targetName: item.name,
            });
            const rn = res.name || item.name;
            host.status(`已恢复：${rn}${rn !== item.name ? `（原名 ${item.name} 已被占用）` : ""}`);
          } catch (e: unknown) { host.status(`恢复失败：${(e as { message?: unknown })?.message || e}`, true); }
        });
        await reload();
      }

      async function trashPurge(item: TrashGItem) {
        openMenu.value = null;
        if (!(await host.confirm(`永久删除 "${item.name}"？`, "不可撤销。"))) return;
        await host.busy(`正在永久删除 ${item.name}…`, async () => {
          try {
            await _store.flow.purge({ trashKey: item.local ? item.local.trashKey : null, cloudItemId: item.cloud ? item.cloud.id : null });
            host.status(`已永久删除：${item.name}`);
          } catch (e: unknown) { host.status(`永久删除失败：${(e as { message?: unknown })?.message || e}`, true); }
        });
        await reload();
      }

      // scope：清哪一端。"local"=仅本地、"cloud"=仅云端、"both"=两端（API 保留，UI 只暴露前两个按钮）。
      async function emptyTrash(scope: "local" | "cloud" | "both" = "both") {
        const label = scope === "local" ? "本地" : scope === "cloud" ? "云端" : "本地和云端";
        if (scope === "cloud" && !(host.signedIn() && host.online())) { host.status("清空云端回收站需先登录并联网", true); return; }
        if (!(await host.confirm(`清空${label}回收站？`, `${label}回收站会被彻底清空，不可撤销。`))) return;
        await host.busy(`正在清空${label}回收站…`, async () => {
          const res = await _store.flow.emptyTrash({ scope, isOnline: () => host.signedIn() && host.online() });
          const cloudFails = ((res.failed || []) as Array<{ where?: string }>).filter((f) => f.where !== "local").length;
          if (scope !== "local" && cloudFails) host.status(`${cloudFails} 项云端没清（可能离线），回线再清`, true);
          else if ((res.failed || []).length) host.status("清空时部分失败", true);
          else host.status(`已清空${label}回收站`);
        });
        await reload();
      }

      return {
        view, folder, loading, openMenu, isEmpty, emptyText,
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
        <div v-if="loading" class="gallery-loading">加载中…</div>

        <template v-if="view==='files' && !loading">
          <div v-for="ft in folderTiles" :key="'F:'+ft.path" class="gallery-tile folder" @click="enterFolder(ft.path)">
            <div class="gallery-tile-thumb" v-html="ICON.folder"></div>
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="ft.path">{{ ft.name }}</div>
              <div class="gallery-tile-meta">{{ ft.empty ? '空文件夹' : '文件夹' }}</div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" aria-label="更多操作" @click.stop="toggleMenu('F:'+ft.path)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!=='F:'+ft.path }" @click.stop>
              <button type="button" class="danger" :disabled="!ft.empty" @click="folderDelete(ft)">{{ ft.empty ? '删除空文件夹' : '删除（请先清空里面）' }}</button>
            </div>
          </div>

          <div v-for="row in fileTiles" :key="row.t.name" class="gallery-tile" :class="{ active: row.t.isActive }" @click="openTile(row.item)">
            <ThumbCell :local-thumb="row.t.hasLocalThumb ? row.item.local.thumb : null" :enc-name="row.t.encrypted ? row.t.name : null" :cloud="row.t.encrypted ? null : row.t.cloud" :fallback="row.t.displayName.slice(0,1) || '?'" :alt="row.t.name" @unlock="onUnlock" />
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="row.t.fullPath">{{ row.t.displayName }}</div>
              <div class="gallery-tile-meta">
                <span v-if="row.t.encrypted" class="gallery-tile-state-icon enc" title="已加密" v-html="ICON.lock"></span>
                <span class="gallery-tile-state-icon" :title="row.t.badgeTitle" v-html="badgeIcon(row.t.badge)"></span>
                <span>{{ fmtMeta(row.t) }}</span>
              </div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" aria-label="更多操作" @click.stop="toggleMenu(row.t.name)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!==row.t.name }" @click.stop>
              <template v-if="row.t.ghost">
                <div class="gallery-menu-note">云端副本已被别的设备移动或删除；本地这份有未推送的修改。</div>
                <button type="button" @click="rename(row.item)">重命名留存</button>
                <button type="button" class="danger" @click="del(row.item)">丢弃（送回收站）</button>
              </template>
              <template v-else>
                <button type="button" @click="rename(row.item)">重命名</button>
                <button type="button" @click="move(row.item)">移动到…</button>
                <button type="button" @click="copy(row.item)">创建副本</button>
                <button v-if="row.t.badge==='cloudOnly'" type="button" @click="openTile(row.item)">拉取到本地</button>
                <button v-if="row.t.badge==='localOnly'" type="button" @click="push(row.item)">推送到云端</button>
                <button v-if="row.t.badge==='dirtyBoth'" type="button" @click="push(row.item)">推送到云端</button>
                <button v-if="row.item.local && row.item.cloud" type="button" @click="unload(row.item)">卸载本地</button>
                <button v-if="row.item.local && !row.t.encrypted" type="button" @click="encryptItem(row.item)">加密保护…</button>
                <button v-if="row.item.local && row.t.encrypted" type="button" @click="decryptItem(row.item)">解除加密…</button>
                <button type="button" class="danger" @click="del(row.item)">送到回收站</button>
              </template>
            </div>
          </div>
        </template>

        <template v-if="view==='trash' && !loading">
          <div v-for="row in trashTiles" :key="row.t.name + row.t.deletedAt" class="gallery-tile">
            <ThumbCell :local-thumb="row.t.hasLocalThumb ? row.item.local.thumb : null" :cloud="row.t.cloud" :fallback="row.t.name.slice(0,1) || '?'" :alt="row.t.name" />
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="row.t.name">{{ row.t.name }}</div>
              <div class="gallery-tile-meta">{{ row.t.source }} · {{ fmtMeta({time: row.t.deletedAt, size: 0}).split(' · ')[0] }} 删除</div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" aria-label="更多操作" @click.stop="toggleMenu('T:'+row.t.name+row.t.deletedAt)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!=='T:'+row.t.name+row.t.deletedAt }" @click.stop>
              <button type="button" @click="trashRestore(row.item)">恢复</button>
              <button type="button" class="danger" @click="trashPurge(row.item)">永久删除</button>
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
