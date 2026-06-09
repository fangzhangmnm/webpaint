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
  createApp, defineComponent, reactive, ref, computed, onMounted, onUnmounted, nextTick,
} from "../../vendor/vue/vue.esm-browser.prod.js";
import {
  store as _store, isCloudDirty, listCloudSessionsRecursive,
  getItemByPath, deleteItem, clearFolderCaches,
  listGallery, listGalleryTrash,
} from "../app-store.js";
import { listSessions } from "../session.js";
import { getOrFetchCloudThumb } from "../cloud-thumb-cache.js";
import { sliceFolder, folderHasContents } from "../gallery-model.js";
import { pathFolder, pathBasename, pathJoin } from "../gallery-path.js";
import { tileFor, breadcrumb, trashTileFor, humanTime, humanSize } from "./gallery-view-model.ts";
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
};

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
const ThumbCell = defineComponent({
  name: "ThumbCell",
  props: {
    localThumb: { default: null },
    cloud: { default: null },
    fallback: { type: String, default: "?" },
    alt: { type: String, default: "" },
  },
  setup(props: any) {
    const url = ref<string | null>(null);
    const showCloud = ref(false);
    const root = ref<HTMLElement | null>(null);
    let objUrl: string | null = null;
    let obs: IntersectionObserver | null = null;
    const setBlob = (blob: Blob) => { objUrl = URL.createObjectURL(blob); url.value = objUrl; };

    onMounted(() => {
      if (props.localThumb) { setBlob(props.localThumb); return; }
      if (props.cloud) {
        showCloud.value = true;
        obs = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            obs?.disconnect(); obs = null;
            const c = props.cloud;
            getOrFetchCloudThumb(c.id, c.eTag || "", c.size || 0, c["@microsoft.graph.downloadUrl"])
              .then(({ blob }: any) => { setBlob(blob); showCloud.value = false; })
              .catch((err: any) => console.warn("[gallery] thumb:", err));
          }
        }, { rootMargin: "600px 0px", threshold: 0.01 });
        nextTick(() => { if (obs && root.value) obs.observe(root.value); });
      }
    });
    onUnmounted(() => { obs?.disconnect(); if (objUrl) URL.revokeObjectURL(objUrl); });
    return { url, showCloud, root, ICON };
  },
  template: `
    <img v-if="url" class="gallery-tile-thumb" :src="url" :alt="alt" loading="lazy" />
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
      const data = reactive<{ items: any[]; cloudFolders: string[] }>({ items: [], cloudFolders: [] });
      const trash = ref<any[]>([]);
      const openMenu = ref<string | null>(null);   // 当前展开的 tile 菜单 key

      function safeFolder() { try { return localStorage.getItem(LS_FOLDER) || ""; } catch { return ""; } }
      function setFolder(p: string) { folder.value = p || ""; try { localStorage.setItem(LS_FOLDER, folder.value); } catch {} openMenu.value = null; }

      async function reload() {
        loading.value = true;
        openMenu.value = null;
        try {
          const st = { signedIn: host.signedIn(), online: host.online() };
          if (view.value === "trash") {
            trash.value = await listGalleryTrash(st);
          } else {
            const r = await listGallery(st);
            data.items = r.items; data.cloudFolders = r.cloudFolders;
            if (r.localError) host.status("本地图库读取失败：" + (r.localError.message || r.localError) + "（隐私窗口 / IDB 被禁？）", true);
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

      const badgeIcon = (k: string) => (ICON as any)[k] || "";
      const fmtMeta = (t: any) => `${humanTime(t.time)} · ${humanSize(t.size)}`;

      // ---- 名字冲突预检（快，无网络放前）----
      async function nameTaken(name: string, alsoCloud: boolean): Promise<string | null> {
        const localNames = new Set((await listSessions()).map((s: any) => s.name));
        if (localNames.has(name)) return "本地";
        if (alsoCloud) {
          try {
            const cloudNames = new Set((await listCloudSessionsRecursive()).map((c: any) => c.path.replace(/\.ora$/i, "")));
            if (cloudNames.has(name)) return "云端";
          } catch (e) { console.warn("[gallery] cloud names:", e); }
        }
        return null;
      }

      // ---- intents（文件管理：本模块自管；画布耦合：转 host）----
      const toggleMenu = (key: string) => { openMenu.value = openMenu.value === key ? null : key; };

      async function openTile(item: any) {
        openMenu.value = null;
        if (item.name === host.activeName()) { await session.open(item); return; }  // 已是活动 → 关库
        await session.open(item);
        await reload();
      }
      function enterFolder(path: string) { setFolder(path); }

      async function rename(item: any) {
        openMenu.value = null;
        const isCloud = !!item.cloud;
        if (item.name === host.activeName()) {
          const nn = await session.rename();
          if (nn && nn !== item.name) host.status(`已重命名：${item.name} → ${nn}`);
          await reload(); return;
        }
        const input = await host.input("重命名", item.name, { placeholder: "新名字" });
        if (input == null) { host.status("已取消"); return; }
        const trimmed = input.trim();
        if (!trimmed) { host.status("名字不能空", true); return; }
        if (trimmed === item.name) { host.status("名字未变"); return; }
        const taken = await nameTaken(trimmed, isCloud);
        if (taken) { host.status(`${taken}已有同名 "${trimmed}"，换一个`, true); return; }
        await host.busy(`正在重命名 ${item.name} → ${trimmed}…`, async () => {
          try {
            const res = await _store.flow.rename(item.name, trimmed, { cloud: isCloud });
            host.status(res.cloudDeferred ? `已重命名（云端稍后重试）：${trimmed}` : `已重命名：${trimmed}`);
          } catch (e: any) { host.status(`重命名失败：${e?.message || e}`, true); }
        });
        await reload();
      }

      async function move(item: any) {
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
          } catch (e: any) { host.status(`移动失败：${e?.message || e}`, true); }
        });
        await reload();
      }

      async function push(item: any) { openMenu.value = null; await session.push(item); await reload(); }
      async function unload(item: any) { openMenu.value = null; await session.unload(item); await reload(); }

      async function del(item: any) {
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
          } catch (e: any) { host.status(`删除失败：${e?.message || e}`, true); }
        });
        await reload();
      }

      async function folderDelete(ft: any) {
        openMenu.value = null;
        if (!ft.empty) { host.status("文件夹非空，请先把里面的作品移走或删除", true); return; }
        await host.busy(`正在删除文件夹 ${ft.name}…`, async () => {
          if (host.signedIn() && host.online()) {
            try {
              const item = await getItemByPath(ft.path);
              if (item && item.folder) await deleteItem(item.id);
              clearFolderCaches();
            } catch (e) { console.warn("[gallery] folder delete:", e); }
          }
          host.status(`已删除空文件夹：${ft.name}`);
        });
        await reload();
      }

      async function trashRestore(item: any) {
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
          } catch (e: any) { host.status(`恢复失败：${e?.message || e}`, true); }
        });
        await reload();
      }

      async function trashPurge(item: any) {
        openMenu.value = null;
        if (!(await host.confirm(`永久删除 "${item.name}"？`, "不可撤销。"))) return;
        await host.busy(`正在永久删除 ${item.name}…`, async () => {
          try {
            await _store.flow.purge({ trashKey: item.local ? item.local.trashKey : null, cloudItemId: item.cloud ? item.cloud.id : null });
            host.status(`已永久删除：${item.name}`);
          } catch (e: any) { host.status(`永久删除失败：${e?.message || e}`, true); }
        });
        await reload();
      }

      async function emptyTrash() {
        if (!(await host.confirm("清空回收站？", "本地和云端的回收站都会清。不可撤销。"))) return;
        await host.busy("正在清空回收站…", async () => {
          const res = await _store.flow.emptyTrash({ isOnline: () => host.signedIn() && host.online() });
          const cloudFails = (res.failed || []).filter((f: any) => f.where !== "local").length;
          if (cloudFails) host.status(`已清本地；${cloudFails} 项云端没清（可能离线），回线再清`, true);
          else if ((res.failed || []).length) host.status("清空时部分失败", true);
          else host.status("回收站已清空");
        });
        await reload();
      }

      return {
        view, folder, loading, openMenu, isEmpty, emptyText,
        folderTiles, fileTiles, trashTiles, crumbs,
        badgeIcon, fmtMeta, ICON, toggleMenu, setFolder, enterFolder,
        openTile, rename, move, push, unload, del, folderDelete, trashRestore, trashPurge, emptyTrash,
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
            <ThumbCell :local-thumb="row.t.hasLocalThumb ? row.item.local.thumb : null" :cloud="row.t.cloud" :fallback="row.t.displayName.slice(0,1) || '?'" :alt="row.t.name" />
            <div class="gallery-tile-name-row">
              <div class="gallery-tile-name" :title="row.t.fullPath">{{ row.t.displayName }}</div>
              <div class="gallery-tile-meta">
                <span class="gallery-tile-state-icon" :title="row.t.badgeTitle" v-html="badgeIcon(row.t.badge)"></span>
                <span>{{ fmtMeta(row.t) }}</span>
              </div>
            </div>
            <button type="button" class="gallery-tile-menu-btn" aria-label="更多操作" @click.stop="toggleMenu(row.t.name)">⋯</button>
            <div class="gallery-tile-menu-popup" :class="{ hidden: openMenu!==row.t.name }" @click.stop>
              <button type="button" @click="rename(row.item)">重命名</button>
              <button type="button" @click="move(row.item)">移动到…</button>
              <button v-if="row.t.badge==='cloudOnly'" type="button" @click="openTile(row.item)">拉取到本地</button>
              <button v-if="row.t.badge==='localOnly'" type="button" @click="push(row.item)">推送到云端</button>
              <button v-if="row.t.badge==='dirtyBoth'" type="button" @click="push(row.item)">推送到云端</button>
              <button v-if="row.item.local && row.item.cloud" type="button" @click="unload(row.item)">卸载本地</button>
              <button type="button" class="danger" @click="del(row.item)">送到回收站</button>
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
  emptyTrash(): void;
  unmount(): void;
}

export function mountGallery(el: HTMLElement, host: GalleryHost): GalleryHandle {
  const app = createApp(makeGallery(host));
  const vm: any = app.mount(el);
  return {
    refresh: () => vm.reload(),
    setView: (v) => vm.setView(v),
    getView: () => vm.view,
    setFolder: (p) => vm.setFolder(p),
    getFolder: () => vm.folder,
    emptyTrash: () => vm.emptyTrash(),
    unmount: () => app.unmount(),
  };
}
