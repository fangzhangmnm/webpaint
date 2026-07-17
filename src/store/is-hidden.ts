// ⚠ store 内部深模块。app 不直接 import——经 createStore。
//
// path-guard（深模块）—— 路径合法性 + 隐藏判定的**唯一真相**。三个函数，两套规则（file 名 vs collection 名不同）：
//   · isHidden(name)：**列举层**过滤——末段（basename）以 "." 开头 = 隐藏（不 list）。store 的安全网夹（`.trash`/`.backup`/
//     `.<appId>`）+ 用户任何 dotfile/dotfolder 都不进图库；但**隐藏 ≠ 禁止创建**（只要不是保留根，dot 项仍可建/用）。
//   · assertValidFileName(name, appId)：**file/文件夹 名**——拒 3 个保留根（`.<appId>/`·`.trash/`·`.backup/`，用户文件落这里
//     会与 collections/安全网撞）；放行其他子路径 + dotfile。
//   · assertValidCollectionName(name)：**collection 名**——禁斜杠（collection 名不是路径；hierarchy 用 `parent.child` 点分）、
//     禁 Windows 非法字符、禁 bare `.`/`..`；**放行**点（含前导点=隐藏 collection）。
//   listing.ts / reconcile.ts / cloud-sync.ts / create-store.ts 共用这一处。

export function isHidden(name: string): boolean {
  if (!name) return false;
  const seg = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return seg.startsWith(".");
}

// file/文件夹 路径护栏：拒 3 个保留根（顶层首段）。放行其他一切子路径/dotfile（隐藏但可用）。
export function assertValidFileName(name: string, appId: string): void {
  if (!name || !name.trim()) throw new Error("路径不能为空");
  const top = name.indexOf("/") >= 0 ? name.slice(0, name.indexOf("/")) : name;
  if (top === ".trash" || top === ".backup" || top === `.${appId}`) {
    throw new Error(`保留根，禁止用作文件/文件夹路径：${top}/（.trash/.backup/.${appId} 归 store 安全网与 collections）`);
  }
}

// collection 名护栏（= 合法文件名、无扩展名、无斜杠）。store 落云时自己追加 `.json`。hierarchy 靠 `parent.child` 点分（放行点）。
export function assertValidCollectionName(name: string): void {
  if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
    throw new Error(`collection 名非法（须合法文件名、无斜杠/无 Windows 非法字符、非 bare .|..；点分层级放行）：${JSON.stringify(name)}`);
  }
}
