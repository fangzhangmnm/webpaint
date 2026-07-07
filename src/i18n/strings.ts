// i18n SSoT —— 唯一 glossary。每 key 四语同居（zh/en/ja 必填 → 漏译=编译错；tok 可选 → fallback en）。
// 设计/纪律见 docs/20260707-i18n-architecture.md。
//   · 不按语言分文件（那样加 key 易漏某语 → 静默漂移）。四语并排 + 类型门守死。
//   · Vue 模板里不写 t()：在 setup/computed 调、以 ref 给模板（否则 tsc 不检查模板 key）。
//   · glyph 图标（笔/混/吸/清 等）不进这里——图标不翻译，只翻它的 tooltip。
//
// > as-of v375 / 2026-07-06

export type Lang = "zh" | "en" | "ja" | "tok";
export type Entry = { zh: string; en: string; ja: string; tok?: string };

export const S = {
  // ── 工具栏 tooltip（SVG 图标的中文提示；括号内快捷键各语保留）──────────────
  "tool.menu":      { zh: "菜单",              en: "Menu",            ja: "メニュー",              tok: "lipu" },
  "tool.brush":     { zh: "笔刷 (B)",          en: "Brush (B)",       ja: "ブラシ (B)",            tok: "ilo sitelen (B)" },
  "tool.eraser":    { zh: "橡皮 (E)",          en: "Eraser (E)",      ja: "消しゴム (E)",          tok: "ilo weka (E)" },
  "tool.picker":    { zh: "吸色 (I)",          en: "Eyedropper (I)",  ja: "スポイト (I)",          tok: "ilo pi kama kule (I)" },
  "tool.lasso":     { zh: "套索 (L)",          en: "Lasso (L)",       ja: "投げ縄 (L)",            tok: "ilo pi kama lili (L)" },
  "tool.pan":       { zh: "平移 (H / Space)",  en: "Pan (H / Space)", ja: "手のひら (H / Space)",  tok: "ilo tawa (H / Space)" },
  "tool.adjust":    { zh: "调整",              en: "Adjust",          ja: "調整",                  tok: "ante" },
  "tool.layers":    { zh: "图层",              en: "Layers",          ja: "レイヤー",              tok: "lipu" },
  "tool.color":     { zh: "颜色 (C)",          en: "Color (C)",       ja: "カラー (C)",            tok: "kule (C)" },
  "action.undo":    { zh: "撤销 (Ctrl+Z)",     en: "Undo (Ctrl+Z)",   ja: "元に戻す (Ctrl+Z)",     tok: "weka (Ctrl+Z)" },
  "action.redo":    { zh: "重做 (Ctrl+Shift+Z)", en: "Redo (Ctrl+Shift+Z)", ja: "やり直す (Ctrl+Shift+Z)", tok: "sin (Ctrl+Shift+Z)" },

  // ── 顶栏 / 导航 ────────────────────────────────────────────────
  "nav.gallery":    { zh: "图库",              en: "Gallery",         ja: "ギャラリー",            tok: "poki lipu" },
  "nav.trash":      { zh: "回收站",            en: "Trash",           ja: "ゴミ箱",                tok: "poki jaki" },
  "save.tip":       { zh: "保存 / 上传",       en: "Save / Upload",   ja: "保存 / アップロード" },
  "enc.locked":     { zh: "已加密 · 点击解除加密", en: "Encrypted · tap to decrypt", ja: "暗号化済み · タップで解除" },
  "enc.locked.aria":{ zh: "已加密",            en: "Encrypted",       ja: "暗号化済み" },
  "cloud.account":  { zh: "云端账号",          en: "Cloud account",   ja: "クラウドアカウント" },
  "cloud.refresh":  { zh: "刷新云端列表",      en: "Refresh cloud list", ja: "クラウド一覧を更新" },
  "account.add.aria":{ zh: "账号 / 新增",      en: "Account / Add",   ja: "アカウント / 追加" },

  // ── ⋯ 设置菜单 ────────────────────────────────────────────────
  "menu.section.settings": { zh: "设置",       en: "Settings",        ja: "設定",                  tok: "nasin" },
  "menu.section.debug":    { zh: "调试",       en: "Debug",           ja: "デバッグ" },
  "menu.checkerboard":     { zh: "透明背景显示棋盘", en: "Checkerboard for transparency", ja: "透明部分に市松模様" },
  "menu.longPressPick":    { zh: "单指长按吸色", en: "Long-press to pick color", ja: "長押しでスポイト" },
  "menu.singleFingerDraw": { zh: "单指绘画",   en: "One-finger drawing", ja: "一本指で描画" },
  "menu.pixelGrid":        { zh: "像素栅格（放大时）", en: "Pixel grid (when zoomed)", ja: "ピクセルグリッド（拡大時）" },
  "menu.theme":            { zh: "主题",       en: "Theme",           ja: "テーマ",                tok: "kule pi lipu" },
  "menu.language":         { zh: "语言",       en: "Language",        ja: "言語",                  tok: "toki" },
  "menu.shortcuts":        { zh: "快捷键",     en: "Shortcuts",       ja: "ショートカット" },
  "menu.resetRack":        { zh: "重置笔架出厂…", en: "Reset brushes…", ja: "ブラシを初期化…" },
  "menu.forceReset":       { zh: "强制更新（清缓存重启）", en: "Force update (clear cache & restart)", ja: "強制更新（キャッシュ削除して再起動）" },
  "menu.smoothDev":        { zh: "平滑调参（dev）", en: "Smoothing tuning (dev)", ja: "スムージング調整（dev）" },
  "menu.fps":              { zh: "FPS 计",     en: "FPS meter",       ja: "FPS 表示" },
  "menu.version":          { zh: "版本：{v}",  en: "Version: {v}",    ja: "バージョン：{v}" },

  // ── 主题状态标签 ──────────────────────────────────────────────
  "theme.auto":     { zh: "跟随系统",          en: "System",          ja: "システムに従う" },
  "theme.day":      { zh: "日",                en: "Light",           ja: "ライト" },
  "theme.night":    { zh: "夜",                en: "Dark",            ja: "ダーク" },

  // ── 通用 ──────────────────────────────────────────────────────
  "common.on":      { zh: "开",                en: "On",              ja: "オン",                  tok: "lon" },
  "common.off":     { zh: "关",                en: "Off",             ja: "オフ",                  tok: "ala" },
  "common.ok":      { zh: "确定",              en: "OK",              ja: "OK",                    tok: "pona" },
  "common.cancel":  { zh: "取消",              en: "Cancel",          ja: "キャンセル",            tok: "weka" },
  "common.notice":  { zh: "提示",              en: "Notice",          ja: "お知らせ" },
  "common.close.aria":{ zh: "关闭",            en: "Close",           ja: "閉じる" },

  // ── 状态行（本切片只接静态默认值 + 设置菜单反馈；setStatus 大面留后续切片）──
  "status.ready":         { zh: "就绪",        en: "Ready",           ja: "準備完了",              tok: "pona" },
  "status.checkerboard":  { zh: "透明棋盘 · {s}", en: "Checkerboard · {s}", ja: "市松模様 · {s}" },
  "status.longPressPick": { zh: "长按吸色 · {s}", en: "Long-press pick · {s}", ja: "長押しスポイト · {s}" },
  "status.singleFingerDraw":{ zh: "单指绘画 · {s}", en: "One-finger draw · {s}", ja: "一本指描画 · {s}" },
  "status.pixelGrid":     { zh: "像素栅格 · {s}", en: "Pixel grid · {s}", ja: "ピクセルグリッド · {s}" },
  "status.fps":           { zh: "FPS 计 · {s}", en: "FPS meter · {s}", ja: "FPS 表示 · {s}" },
  "status.theme":         { zh: "主题 · {s}",  en: "Theme · {s}",     ja: "テーマ · {s}" },
  "status.language":      { zh: "语言 · {s}",  en: "Language · {s}",  ja: "言語 · {s}" },

  // ── ⋯ 菜单：文件段（切片 2）────────────────────────────────────
  "menu.section.file":   { zh: "文件",        en: "File",            ja: "ファイル" },
  "menu.importImage":    { zh: "导入图片",    en: "Import image",    ja: "画像を読み込む" },
  "menu.exportImage":    { zh: "导出图片",    en: "Export image",    ja: "画像を書き出す" },
  "menu.exportProject":  { zh: "导出项目",    en: "Export project",  ja: "プロジェクトを書き出す" },
  "menu.rename":         { zh: "重命名当前画作…", en: "Rename artwork…", ja: "作品名を変更…" },
  "menu.saveAs":         { zh: "另存为…",     en: "Save as…",        ja: "名前を付けて保存…" },
  "menu.revert":         { zh: "撤销修改…",   en: "Revert changes…", ja: "変更を取り消す…" },
  "menu.encrypt":        { zh: "加密保护…",   en: "Encrypt…",        ja: "暗号化…" },
  "menu.decrypt":        { zh: "解除加密…",   en: "Decrypt…",        ja: "暗号化を解除…" },
  "menu.cropToSelection":{ zh: "裁切到选区",  en: "Crop to selection", ja: "選択範囲で切り抜き" },
  "menu.cropFree":       { zh: "裁切（自由）", en: "Crop (free)",     ja: "切り抜き（自由）" },
  "menu.flipH":          { zh: "水平翻转",    en: "Flip horizontal", ja: "左右反転" },
  "menu.rotate90":       { zh: "逆时针旋转 90°", en: "Rotate 90° CCW", ja: "反時計回りに90°回転" },
  "menu.offset":         { zh: "偏移接缝（环绕）…", en: "Offset seam (wrap)…", ja: "シームをずらす（ラップ）…" },
  "menu.resample":       { zh: "调整尺寸",    en: "Resize",          ja: "サイズ変更" },
  "menu.reference":      { zh: "参考小窗",    en: "Reference window", ja: "参考ウィンドウ" },
  "menu.fit":            { zh: "视口复位",    en: "Reset view",      ja: "ビューをリセット" },
  "menu.config.importImage":  { zh: "配置导入图片", en: "Import settings", ja: "読み込み設定" },
  "menu.config.exportImage":  { zh: "配置导出图片", en: "Export settings", ja: "書き出し設定" },
  "menu.config.exportProject":{ zh: "配置导出项目", en: "Project export settings", ja: "プロジェクト書き出し設定" },

  // ── 菜单子标签片段（导入/导出行的 sub；组合成 "PNG · 合并 · 文件"）──
  "sub.activeLayer": { zh: "当前层",   en: "Active layer", ja: "アクティブ層" },
  "sub.merged":      { zh: "合并",     en: "Merged",       ja: "統合" },
  "sub.clipboard":   { zh: "剪切板",   en: "Clipboard",    ja: "クリップボード" },
  "sub.print":       { zh: "打印",     en: "Print",        ja: "印刷" },
  "sub.file":        { zh: "文件",     en: "File",         ja: "ファイル" },
  "sub.newLayer":    { zh: "新图层",   en: "New layer",    ja: "新規レイヤー" },

  // ── 顶栏保存按钮 tooltip（save-status.ts 按态动态设，{name}=作品名）──
  "save.none":       { zh: "未打开作品", en: "No artwork open", ja: "作品が開かれていません" },
  "save.uploading":  { zh: "上传中… · {name}", en: "Uploading… · {name}", ja: "アップロード中… · {name}" },
  "save.saving":     { zh: "保存中… · {name}", en: "Saving… · {name}", ja: "保存中… · {name}" },
  "save.dirty":      { zh: "保存 + 推送 (Ctrl+S) · {name} · 未保存", en: "Save + push (Ctrl+S) · {name} · unsaved", ja: "保存＋アップロード (Ctrl+S) · {name} · 未保存" },
  "save.cloudDirty": { zh: "推送到云端 (Ctrl+S) · {name} · 本地已存，云端未同步", en: "Push to cloud (Ctrl+S) · {name} · saved locally, not synced", ja: "クラウドにアップロード (Ctrl+S) · {name} · ローカル保存済み、未同期" },
  "save.synced":     { zh: "已同步云端（上次保存时）· 点击检查是否有新版本 · {name}", en: "Synced to cloud (at last save) · tap to check for newer · {name}", ja: "クラウド同期済み（前回保存時）· タップで更新確認 · {name}" },
  "save.localOnly":  { zh: "已存本地（IDB 易失，登录云端更安全） · {name}", en: "Saved locally (IDB is volatile; sign in for safety) · {name}", ja: "ローカル保存済み（IDBは揮発性、クラウド推奨） · {name}" },
} as const satisfies Record<string, Entry>;
