// layer-tree2 —— workpiece v2 的层树组件（纯 json substrate，ADR-0008 §3；T3）。
// ⚠ 临时文件名：T5 拆掉 v1 门面（layer-tree.ts）后收编正名。
//
// substrate = TreeJson（纯数据，可持久化）；像素只持 pixelsRef（LayerTiles tileset 注册表的 id）。
// 写 = 换新根（旧根整体进 collector/record——一个 token 至多一份原件，中间产物即弃）。
// 实现取整树深拷（≤64 叶、字段个位数，KB 级；提案里的路径级结构共享是后续优化，契约不变——
// record 反正持根引用，浅省的只是未动子树的对象复用）。
//
// 所有权算术（消灭 TreeStructureOp 注释在案的 bounded 泄漏）：
//   每个**活根**（substrate + collector + 栈上各 record）按其 json 里每个 leaf.pixelsRef 计 +1。
//   swap 只交换根、计数不动；record 驱逐/清栈 → releaseRoot → tileset 归零还池。
//   删层的 tileset 由 record 的旧根持有——undo 能复活，驱逐才释放，无泄漏（回归测试钉住）。
//
// setActive = 唯一不记账 verb（焦点=导航，ADR-0008 §4；显式声明态）：换根不收集、无需令牌。
// 注意 recorded 步的根快照含 activeId → undo/redo 会把焦点带回该步当时的位置（v1 各 operator
// 手工 setActiveById 的行为在 v2 下由根快照天然给出）。

import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";
import type { LayerTiles, Rect } from "./layer-tiles.ts";
import { LayerPixels } from "../tiles/tile-layer.ts";

export interface TreeLeaf {
  id: number; name: string; visible: boolean; opacity: number; mode: string;
  clippingMask: boolean; lockAlpha: boolean; pixelsRef: number;
}
export interface TreeGroup {
  id: number; name: string; visible: boolean; opacity: number; mode: string;
  clippingMask: boolean; children: TreeNode[];
}
export type TreeNode = TreeLeaf | TreeGroup;
export interface TreeJson {
  nodes: TreeNode[];                 // index 0 = 最底层（沿 v1 约定）
  activeId: number | null;
  referenceLayerId: number | null;
  backgroundColor: string;
  width: number;
  height: number;
}
export const isGroupNode = (n: TreeNode): n is TreeGroup => "children" in n;

export type LayerPropKey = "name" | "visible" | "opacity" | "mode" | "clippingMask" | "lockAlpha";

interface TreeRecord { json: TreeJson }

export class LayerTree2 implements CollectorComponent {
  readonly kind = "layerTree";
  private _wp: Workpiece;
  private _tiles: LayerTiles;
  private _json: TreeJson;
  private _collectedRoot: TreeJson | null = null;
  private _nextId: number;
  private _maxLeaves: () => number;

  constructor(deps: { wp: Workpiece; tiles: LayerTiles; initial: TreeJson; maxLeaves?: () => number }) {
    this._wp = deps.wp;
    this._tiles = deps.tiles;
    this._json = deps.initial;
    this._maxLeaves = deps.maxLeaves ?? (() => 64);
    this._acquireRoot(this._json);
    let maxId = 0;
    this._eachNode(this._json.nodes, (n) => { if (n.id > maxId) maxId = n.id; });
    this._nextId = maxId + 1;
  }

  // ── 读口 ──
  /** 不可变值约定：发出去的引用永不被改（每次写换新根）。 */
  view(): Readonly<TreeJson> { return this._json; }
  nodeById(id: number | null): TreeNode | null {
    if (id === null) return null;
    let f: TreeNode | null = null;
    this._eachNode(this._json.nodes, (n) => { if (n.id === id) f = n; });
    return f;
  }
  leafById(id: number | null): TreeLeaf | null {
    const n = this.nodeById(id);
    return n && !isGroupNode(n) ? n : null;
  }
  countLeaves(): number {
    let c = 0;
    this._eachNode(this._json.nodes, (n) => { if (!isGroupNode(n)) c++; });
    return c;
  }
  eachLeaf(cb: (leaf: TreeLeaf) => void): void {
    this._eachNode(this._json.nodes, (n) => { if (!isGroupNode(n)) cb(n); });
  }

  // ── verbs（token 开着才合法；边界行为写进名字）──

  /** 插到 active 同级上方（无 active → 顶层最上）；active = 新层。null = 已到 maxLeaves。 */
  addLayer(name?: string): TreeLeaf | null {
    if (this.countLeaves() >= this._maxLeaves()) return null;
    const id = this._nextId++;
    const lp = new LayerPixels(this._json.width, this._json.height);
    const ref = this._tiles.createTileset(lp);
    const leaf: TreeLeaf = {
      id, name: name ?? `Layer ${id}`, visible: true, opacity: 1, mode: "source-over",
      clippingMask: false, lockAlpha: false, pixelsRef: ref,
    };
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, next.activeId);
    if (loc) loc.parentArr.splice(loc.index + 1, 0, leaf);
    else next.nodes.push(leaf);
    next.activeId = id;
    this._swapRoot(next);
    this._tiles.releaseTileset(ref);   // json 已收养（_swapRoot acquire）——净移交
    return this.leafById(id);
  }

  /** 新建**空**组（v1 addGroup 语义）：active 是组 → 嵌进去；否则同级之上。active = 新组。
   *  组不计 maxLeaves（只数叶）。 */
  addGroup(name?: string): TreeGroup | null {
    const id = this._nextId++;
    const g: TreeGroup = { id, name: name ?? `Group ${id}`, visible: true, opacity: 1, mode: "source-over", clippingMask: false, children: [] };
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, next.activeId);
    if (loc && isGroupNode(loc.parentArr[loc.index])) (loc.parentArr[loc.index] as TreeGroup).children.push(g);
    else if (loc) loc.parentArr.splice(loc.index + 1, 0, g);
    else next.nodes.push(g);
    next.activeId = id;
    this._swapRoot(next);
    const made = this.nodeById(id);
    return made && isGroupNode(made) ? made : null;
  }

  /** 换整根（load 的令牌写；ADR-0008：解码器产 plain data 灌入）。
   *  调用方负责新根 tileset 的净移交（createTileset 后 release）；旧根照常进 collector/record，
   *  load 收尾清栈时旧 doc 资源随 record 驱逐释放。nextId 重播种。 */
  loadRoot(json: TreeJson): void {
    this._swapRoot(json);
    let maxId = 0;
    this._eachNode(json.nodes, (n) => { if (n.id > maxId) maxId = n.id; });
    this._nextId = maxId + 1;
  }

  /** 复制叶（props 原样、tileset 句柄共享零拷贝）；插到源上方，active = 副本。null = maxLeaves/源不在。 */
  duplicateLayer(id: number): TreeLeaf | null {
    if (this.countLeaves() >= this._maxLeaves()) return null;
    const src = this.leafById(id);
    if (!src) return null;
    const ref = this._tiles.duplicateTileset(src.pixelsRef);
    if (ref === null) return null;
    const nid = this._nextId++;
    const leaf: TreeLeaf = { ...src, id: nid, pixelsRef: ref };
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    loc.parentArr.splice(loc.index + 1, 0, leaf);
    next.activeId = nid;
    this._swapRoot(next);
    this._tiles.releaseTileset(ref);
    return this.leafById(nid);
  }

  /** 删叶（keep-one 守卫：最后一叶不删）。active 被删 → 就近换（下方优先）。 */
  removeLayer(id: number): boolean {
    const leaf = this.leafById(id);
    if (!leaf || this.countLeaves() <= 1) return false;
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    loc.parentArr.splice(loc.index, 1);
    if (next.activeId === id) next.activeId = this._nearestLeafId(next.nodes, loc);
    if (next.referenceLayerId === id) next.referenceLayerId = null;
    this._swapRoot(next);
    return true;
  }

  /** 删组连带 children；删空补一叶。 */
  removeGroupAndFillEmpty(id: number): boolean {
    const n = this.nodeById(id);
    if (!n || !isGroupNode(n)) return false;
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    loc.parentArr.splice(loc.index, 1);
    let leaves = 0;
    this._eachNode(next.nodes, (x) => { if (!isGroupNode(x)) leaves++; });
    if (leaves === 0) {
      const nid = this._nextId++;
      const lp = new LayerPixels(next.width, next.height);
      const ref = this._tiles.createTileset(lp);
      next.nodes.push({ id: nid, name: `Layer ${nid}`, visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixelsRef: ref });
      next.activeId = nid;
      this._swapRoot(next);
      this._tiles.releaseTileset(ref);
    } else {
      if (next.activeId !== null && !this._contains(next.nodes, next.activeId)) next.activeId = this._nearestLeafId(next.nodes, loc);
      if (next.referenceLayerId !== null && !this._contains(next.nodes, next.referenceLayerId)) next.referenceLayerId = null;
      this._swapRoot(next);
    }
    return true;
  }

  /** 解组：children 提到原位（顺序保持）。 */
  explodeGroupInPlace(id: number): boolean {
    const n = this.nodeById(id);
    if (!n || !isGroupNode(n)) return false;
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    const g = loc.parentArr[loc.index] as TreeGroup;
    loc.parentArr.splice(loc.index, 1, ...g.children);
    this._swapRoot(next);
    return true;
  }

  /** 同级移动 delta（越界 → false 不动）。 */
  moveLayer(id: number, delta: number): boolean {
    if (!this.nodeById(id)) return false;
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    const to = loc.index + delta;
    if (to < 0 || to >= loc.parentArr.length) return false;
    const [n] = loc.parentArr.splice(loc.index, 1);
    loc.parentArr.splice(to, 0, n);
    this._swapRoot(next);
    return true;
  }

  /** 移入组（放组内最上）。组不存在/自嵌套 → false。 */
  moveIntoGroup(id: number, gid: number): boolean {
    if (id === gid) return false;
    const g0 = this.nodeById(gid);
    if (!g0 || !isGroupNode(g0)) return false;
    const moving = this.nodeById(id);
    if (!moving) return false;
    if (isGroupNode(moving) && this._contains([moving], gid)) return false;   // 组不能进自己后代
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    const [n] = loc.parentArr.splice(loc.index, 1);
    let target: TreeGroup | null = null;
    this._eachNode(next.nodes, (x) => { if (x.id === gid && isGroupNode(x)) target = x; });
    if (!target) return false;   // clone 前查过，防御
    (target as TreeGroup).children.push(n);
    this._swapRoot(next);
    return true;
  }

  /** 移出组：提到组的同级、组上方。不在组内 → false。 */
  moveOutOfGroup(id: number): boolean {
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id);
    if (!loc || loc.parentGroup === null) return false;
    const [n] = loc.parentArr.splice(loc.index, 1);
    const gloc = this._locate(next.nodes, loc.parentGroup.id)!;
    gloc.parentArr.splice(gloc.index + 1, 0, n);
    this._swapRoot(next);
    return true;
  }

  /** 向下合并：合成字节外部烤好递入（零 GL）。under 归一化（opacity=1/source-over/resultClipping）、
   *  top 移除、active=under。守卫：同级正下方必须是叶、under 剪裁而 top 不剪 → false（语义不清）。 */
  mergeDown(id: number, merged: { bytes: Uint8ClampedArray; rect: Rect; resultClipping: boolean }): boolean {
    const top = this.leafById(id);
    if (!top) return false;
    const loc0 = this._locate(this._json.nodes, id)!;
    if (loc0.index <= 0) return false;
    const under0 = loc0.parentArr[loc0.index - 1];
    if (isGroupNode(under0)) return false;
    if (under0.clippingMask && !top.clippingMask) return false;
    // 像素先写（tiles collector 收 diff；undo 倒序会先还原树再还原像素，两态里 under 都在）
    this._tiles.replaceLayer(under0.id, merged.bytes, merged.rect);
    const next = this._clone(this._json);
    const loc = this._locate(next.nodes, id)!;
    const under = loc.parentArr[loc.index - 1] as TreeLeaf;
    under.opacity = 1;
    under.mode = "source-over";
    under.clippingMask = merged.resultClipping;
    loc.parentArr.splice(loc.index, 1);
    next.activeId = under.id;
    if (next.referenceLayerId === id) next.referenceLayerId = null;
    this._swapRoot(next);
    return true;
  }

  setLayerProp(id: number, prop: LayerPropKey, value: unknown): boolean {
    if (!this.nodeById(id)) return false;
    const next = this._clone(this._json);
    let ok = false;
    this._eachNode(next.nodes, (n) => {
      if (n.id !== id) return;
      if (prop === "lockAlpha" && isGroupNode(n)) return;   // 组无 lockAlpha
      (n as unknown as Record<string, unknown>)[prop] = value;
      ok = true;
    });
    if (!ok) return false;
    this._swapRoot(next);
    return true;
  }

  /** 元规则相同才合并动词（提案 .h）：doc 级 unique 值。 */
  setTreeProp(key: "referenceLayerId" | "backgroundColor", value: number | null | string): void {
    const next = this._clone(this._json);
    (next as unknown as Record<string, unknown>)[key] = value;
    this._swapRoot(next);
  }

  /** 唯一不记账 verb（焦点=导航）：无需令牌、不收集；换根共享 nodes（records 不受扰）。 */
  setActive(id: number): boolean {
    if (!this.nodeById(id)) return false;
    this._json = { ...this._json, activeId: id };
    return true;
  }

  // ── CollectorComponent ──

  sealRecord(): RecordData | null {
    if (!this._collectedRoot) return null;
    const r: TreeRecord = { json: this._collectedRoot };
    this._collectedRoot = null;
    return r;
  }
  swapRecord(data: RecordData): RecordData {
    const r = data as TreeRecord;
    const cur = this._json;
    this._json = r.json;
    return { json: cur };   // 根交换 = 所有权移交，计数不动
  }
  recordBytes(data: RecordData): number {
    let n = 0;
    this._eachNode((data as TreeRecord).json.nodes, () => n++);
    return 256 * (n + 1);
  }
  disposeRecord(data: RecordData): void {
    this._releaseRoot((data as TreeRecord).json);
  }

  // ── 内部 ──

  private _swapRoot(next: TreeJson): void {
    this._wp._componentWrite(this);
    this._acquireRoot(next);
    if (this._collectedRoot === null) {
      this._collectedRoot = this._json;      // 令牌前原件进 collector（引用保持，计数不动）
    } else {
      this._releaseRoot(this._json);         // 本 token 中间产物即弃
    }
    this._json = next;
  }

  private _acquireRoot(json: TreeJson): void {
    this._eachNode(json.nodes, (n) => { if (!isGroupNode(n)) this._tiles.acquireTileset(n.pixelsRef); });
  }
  private _releaseRoot(json: TreeJson): void {
    this._eachNode(json.nodes, (n) => { if (!isGroupNode(n)) this._tiles.releaseTileset(n.pixelsRef); });
  }

  private _eachNode(nodes: TreeNode[], cb: (n: TreeNode) => void): void {
    for (const n of nodes) { cb(n); if (isGroupNode(n)) this._eachNode(n.children, cb); }
  }
  private _contains(nodes: TreeNode[], id: number): boolean {
    let f = false;
    this._eachNode(nodes, (n) => { if (n.id === id) f = true; });
    return f;
  }
  private _clone(json: TreeJson): TreeJson {
    const cloneNodes = (ns: TreeNode[]): TreeNode[] =>
      ns.map((n) => (isGroupNode(n) ? { ...n, children: cloneNodes(n.children) } : { ...n }));
    return { ...json, nodes: cloneNodes(json.nodes) };
  }
  /** 定位 id 所在的 children 数组（parentGroup=null 表示顶层）。 */
  private _locate(nodes: TreeNode[], id: number | null): { parentArr: TreeNode[]; parentGroup: TreeGroup | null; index: number } | null {
    if (id === null) return null;
    const walk = (arr: TreeNode[], pg: TreeGroup | null): { parentArr: TreeNode[]; parentGroup: TreeGroup | null; index: number } | null => {
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (n.id === id) return { parentArr: arr, parentGroup: pg, index: i };
        if (isGroupNode(n)) { const r = walk(n.children, n); if (r) return r; }
      }
      return null;
    };
    return walk(nodes, null);
  }
  /** 删除位置的就近叶（同级下方优先，其次上方，再全树第一叶）。 */
  private _nearestLeafId(nodes: TreeNode[], loc: { parentArr: TreeNode[]; index: number }): number | null {
    const leafIn = (n: TreeNode): number | null => {
      if (!isGroupNode(n)) return n.id;
      for (const c of n.children) { const r = leafIn(c); if (r !== null) return r; }
      return null;
    };
    for (let i = loc.index - 1; i >= 0; i--) { const r = leafIn(loc.parentArr[i]); if (r !== null) return r; }
    for (let i = loc.index; i < loc.parentArr.length; i++) { const r = leafIn(loc.parentArr[i]); if (r !== null) return r; }
    for (const n of nodes) { const r = leafIn(n); if (r !== null) return r; }
    return null;
  }
}
