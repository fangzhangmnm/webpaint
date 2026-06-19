// Gallery 路径代数（A2，见 docs/reports/20260606-fresh-geological-survey.html）。
// 图库 item 的 name 是扁平字符串，用 "/" 表达文件夹层级（无真嵌套结构）。
// 这三个纯字符串操作过去内联在 app.js，被 rename/move/breadcrumb/切片多处调用。
export function pathFolder(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i);
}
export function pathBasename(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}
export function pathJoin(folder: string, name: string): string {
  if (!folder) return name;
  if (!name) return folder;
  return `${folder}/${name}`;
}
