export type Lang = "zh" | "en" | "ja" | "tok";
export type Entry = {
    zh: string;
    en: string;
    ja: string;
    tok?: string;
};
export declare const S: {
    readonly "tool.menu": {
        readonly zh: "菜单";
        readonly en: "Menu";
        readonly ja: "メニュー";
        readonly tok: "nasin";
    };
    readonly "tool.brush": {
        readonly zh: "笔刷 (B)";
        readonly en: "Brush (B)";
        readonly ja: "ブラシ (B)";
        readonly tok: "ilo sitelen (B)";
    };
    readonly "tool.eraser": {
        readonly zh: "橡皮 (E)";
        readonly en: "Eraser (E)";
        readonly ja: "消しゴム (E)";
        readonly tok: "ilo weka (E)";
    };
    readonly "tool.picker": {
        readonly zh: "吸色 (I)";
        readonly en: "Eyedropper (I)";
        readonly ja: "スポイト (I)";
        readonly tok: "ilo pi kama kule (I)";
    };
    readonly "tool.fill": {
        readonly zh: "油漆桶 (G)";
        readonly en: "Paint bucket (G)";
        readonly ja: "塗りつぶし (G)";
        readonly tok: "ilo pi kule ma (G)";
    };
    readonly "tool.lasso": {
        readonly zh: "套索 (L)";
        readonly en: "Lasso (L)";
        readonly ja: "投げ縄 (L)";
        readonly tok: "ilo pi ma wile (L)";
    };
    readonly "tool.shapeBrush": {
        readonly zh: "形状笔";
        readonly en: "Shape brush";
        readonly ja: "図形ブラシ";
        readonly tok: "ilo selo";
    };
    readonly "tool.pan": {
        readonly zh: "平移 (H / Space)";
        readonly en: "Pan (H / Space)";
        readonly ja: "手のひら (H / Space)";
        readonly tok: "ilo tawa (H / Space)";
    };
    readonly "tool.adjust": {
        readonly zh: "调整";
        readonly en: "Adjust";
        readonly ja: "調整";
        readonly tok: "ante kule";
    };
    readonly "tool.layers": {
        readonly zh: "图层";
        readonly en: "Layers";
        readonly ja: "レイヤー";
        readonly tok: "lipu";
    };
    readonly "tool.color": {
        readonly zh: "颜色 (C)";
        readonly en: "Color (C)";
        readonly ja: "カラー (C)";
        readonly tok: "kule (C)";
    };
    readonly "action.undo": {
        readonly zh: "撤销 (Ctrl+Z)";
        readonly en: "Undo (Ctrl+Z)";
        readonly ja: "元に戻す (Ctrl+Z)";
        readonly tok: "o weka e pali pini (Ctrl+Z)";
    };
    readonly "action.redo": {
        readonly zh: "重做 (Ctrl+Shift+Z)";
        readonly en: "Redo (Ctrl+Shift+Z)";
        readonly ja: "やり直す (Ctrl+Shift+Z)";
        readonly tok: "o pali sin (Ctrl+Shift+Z)";
    };
    readonly "nav.gallery": {
        readonly zh: "图库";
        readonly en: "Gallery";
        readonly ja: "ギャラリー";
        readonly tok: "tomo sitelen";
    };
    readonly "menu.backToGallery": {
        readonly zh: "回到图库";
        readonly en: "Back to gallery";
        readonly ja: "ギャラリーに戻る";
        readonly tok: "o tawa tomo sitelen";
    };
    readonly "nav.trash": {
        readonly zh: "回收站";
        readonly en: "Trash";
        readonly ja: "ゴミ箱";
        readonly tok: "poki jaki";
    };
    readonly "save.tip": {
        readonly zh: "保存 / 上传";
        readonly en: "Save / Upload";
        readonly ja: "保存 / アップロード";
        readonly tok: "awen / pana tawa poki sewi";
    };
    readonly "enc.locked": {
        readonly zh: "已加密 · 点击解除加密";
        readonly en: "Encrypted · tap to decrypt";
        readonly ja: "暗号化済み · タップで解除";
        readonly tok: "ni li len. sina luka e ni la len li weka.";
    };
    readonly "enc.locked.aria": {
        readonly zh: "已加密";
        readonly en: "Encrypted";
        readonly ja: "暗号化済み";
        readonly tok: "len";
    };
    readonly "cloud.account": {
        readonly zh: "云端账号";
        readonly en: "Cloud account";
        readonly ja: "クラウドアカウント";
        readonly tok: "nimi sina pi poki sewi";
    };
    readonly "cloud.refresh": {
        readonly zh: "刷新云端列表";
        readonly en: "Refresh cloud list";
        readonly ja: "クラウド一覧を更新";
        readonly tok: "o lukin sin e poki sewi";
    };
    readonly "account.add.aria": {
        readonly zh: "账号 / 新增";
        readonly en: "Account / Add";
        readonly ja: "アカウント / 追加";
        readonly tok: "nimi sina / sin";
    };
    readonly "menu.checkerboard": {
        readonly zh: "透明背景显示棋盘";
        readonly en: "Checkerboard for transparency";
        readonly ja: "透明部分に市松模様";
        readonly tok: "leko pi kule kon";
    };
    readonly "menu.longPressPick": {
        readonly zh: "单指长按吸色";
        readonly en: "Long-press to pick color";
        readonly ja: "長押しでスポイト";
        readonly tok: "luka awen li kama e kule";
    };
    readonly "menu.singleFingerDraw": {
        readonly zh: "单指绘画";
        readonly en: "One-finger drawing";
        readonly ja: "一本指で描画";
        readonly tok: "luka wan li sitelen";
    };
    readonly "menu.pixelGrid": {
        readonly zh: "像素栅格（放大时）";
        readonly en: "Pixel grid (when zoomed)";
        readonly ja: "ピクセルグリッド（拡大時）";
        readonly tok: "kulupu leko lili (lon lukin suli)";
    };
    readonly "menu.docGrid": {
        readonly zh: "主栅格（对齐网格）";
        readonly en: "Main grid (alignment)";
        readonly ja: "メイングリッド（整列）";
        readonly tok: "kulupu leko suli";
    };
    readonly "nd.grp.painting": {
        readonly zh: "绘画";
        readonly en: "Painting";
        readonly ja: "ペイント";
        readonly tok: "sitelen";
    };
    readonly "nd.grp.print": {
        readonly zh: "打印 · 300dpi";
        readonly en: "Print · 300dpi";
        readonly ja: "印刷 · 300dpi";
        readonly tok: "suli lipu · 300dpi";
    };
    readonly "nd.grp.pixel": {
        readonly zh: "像素画";
        readonly en: "Pixel art";
        readonly ja: "ドット絵";
        readonly tok: "sitelen leko";
    };
    readonly "nd.o1920": {
        readonly zh: "1920 × 1080（横）";
        readonly en: "1920 × 1080 (landscape)";
        readonly ja: "1920 × 1080（横）";
        readonly tok: "1920 × 1080 (poka)";
    };
    readonly "nd.o1080": {
        readonly zh: "1080 × 1920（竖）";
        readonly en: "1080 × 1920 (portrait)";
        readonly ja: "1080 × 1920（縦）";
        readonly tok: "1080 × 1920 (sewi)";
    };
    readonly "nd.o1200x900": {
        readonly zh: "1200 × 900（横 4:3）";
        readonly en: "1200 × 900 (landscape 4:3)";
        readonly ja: "1200 × 900（横 4:3）";
        readonly tok: "1200 × 900 (poka 4:3)";
    };
    readonly "nd.o900x1200": {
        readonly zh: "900 × 1200（竖 3:4）";
        readonly en: "900 × 1200 (portrait 3:4)";
        readonly ja: "900 × 1200（縦 3:4）";
        readonly tok: "900 × 1200 (sewi 3:4)";
    };
    readonly "nd.print6in": {
        readonly zh: "6寸照片 4×6in 竖";
        readonly en: "4×6″ photo, portrait";
        readonly ja: "写真 KG判 4×6in 縦";
        readonly tok: "sitelen lili 4×6in (sewi)";
    };
    readonly "nd.print8in": {
        readonly zh: "8寸照片 6×8in 竖";
        readonly en: "6×8″ photo, portrait";
        readonly ja: "写真 6×8in 縦";
        readonly tok: "sitelen suli 6×8in (sewi)";
    };
    readonly "nd.printPostcard": {
        readonly zh: "明信片 100×148mm 竖";
        readonly en: "Postcard 100×148 mm, portrait";
        readonly ja: "はがき 100×148mm 縦";
        readonly tok: "lipu toki 100×148mm (sewi)";
    };
    readonly "nd.printPostcardLand": {
        readonly zh: "明信片 100×148mm 横";
        readonly en: "Postcard 100×148 mm, landscape";
        readonly ja: "はがき 100×148mm 横";
        readonly tok: "lipu toki 100×148mm (poka)";
    };
    readonly "nd.print8inLand": {
        readonly zh: "8寸照片 6×8in 横";
        readonly en: "6×8″ photo, landscape";
        readonly ja: "写真 6×8in 横";
        readonly tok: "sitelen suli 6×8in (poka)";
    };
    readonly "nd.print6inLand": {
        readonly zh: "6寸照片 4×6in 横";
        readonly en: "4×6″ photo, landscape";
        readonly ja: "写真 KG判 4×6in 横";
        readonly tok: "sitelen lili 4×6in (poka)";
    };
    readonly "nd.print5x7": {
        readonly zh: "5×7in 竖";
        readonly en: "5×7″, portrait";
        readonly ja: "5×7in 縦";
        readonly tok: "5×7in (sewi)";
    };
    readonly "nd.print5x7Land": {
        readonly zh: "5×7in 横";
        readonly en: "5×7″, landscape";
        readonly ja: "5×7in 横";
        readonly tok: "5×7in (poka)";
    };
    readonly "nd.printA5": {
        readonly zh: "A5 竖";
        readonly en: "A5 portrait";
        readonly ja: "A5 縦";
        readonly tok: "A5 (sewi)";
    };
    readonly "nd.printA5Land": {
        readonly zh: "A5 横";
        readonly en: "A5 landscape";
        readonly ja: "A5 横";
        readonly tok: "A5 (poka)";
    };
    readonly "nd.printA4": {
        readonly zh: "A4 竖";
        readonly en: "A4 portrait";
        readonly ja: "A4 縦";
        readonly tok: "A4 (sewi)";
    };
    readonly "nd.printA4Land": {
        readonly zh: "A4 横";
        readonly en: "A4 landscape";
        readonly ja: "A4 横";
        readonly tok: "A4 (poka)";
    };
    readonly "tm.configRange": {
        readonly zh: "裁剪";
        readonly en: "Crop";
        readonly ja: "切り抜き";
        readonly tok: "kipisi";
    };
    readonly "tm.clipToSelection": {
        readonly zh: "裁到选区";
        readonly en: "Clip to selection";
        readonly ja: "選択範囲に切り抜き";
        readonly tok: "o kipisi tawa ma wile";
    };
    readonly "tm.defringe": {
        readonly zh: "贴图防黑边（透明区回填边缘色，仅 PNG）";
        readonly en: "Defringe for textures (extend edge colors under transparency, PNG only)";
        readonly ja: "テクスチャ用フリンジ除去（透明部に縁色を延長、PNG のみ）";
        readonly tok: "pona e selo (kule pi poka li tawa insa pi ala, PNG taso)";
    };
    readonly "tm.configBg": {
        readonly zh: "背景";
        readonly en: "Background";
        readonly ja: "背景";
        readonly tok: "monsi";
    };
    readonly "tm.bgTransparent": {
        readonly zh: "透明（JPG=白底）";
        readonly en: "Transparent (JPG = white)";
        readonly ja: "透明（JPG は白）";
        readonly tok: "ala (JPG la walo)";
    };
    readonly "tm.bgWhite": {
        readonly zh: "白";
        readonly en: "White";
        readonly ja: "白";
        readonly tok: "walo";
    };
    readonly "tm.bgBlack": {
        readonly zh: "黑";
        readonly en: "Black";
        readonly ja: "黒";
        readonly tok: "pimeja";
    };
    readonly "tm.bgCustom": {
        readonly zh: "自定义";
        readonly en: "Custom";
        readonly ja: "カスタム";
        readonly tok: "ante";
    };
    readonly "tm.bgCustomPh": {
        readonly zh: "hex / 色名 / 5600k";
        readonly en: "hex / color name / 5600k";
        readonly ja: "hex / 色名 / 5600k";
        readonly tok: "hex / nimi kule / 5600k";
    };
    readonly "tm.noSelectionNow": {
        readonly zh: "当前无选区";
        readonly en: "no selection";
        readonly ja: "選択なし";
        readonly tok: "ma wile li lon ala";
    };
    readonly "sub.selection": {
        readonly zh: "选区";
        readonly en: "selection";
        readonly ja: "選択範囲";
        readonly tok: "ma wile";
    };
    readonly "menu.docGridCell": {
        readonly zh: "主栅格尺寸…";
        readonly en: "Main grid size…";
        readonly ja: "メイングリッドのサイズ…";
        readonly tok: "suli pi kulupu leko…";
    };
    readonly "menu.docGridCellTitle": {
        readonly zh: "主栅格尺寸（doc 像素，2–1024）";
        readonly en: "Main grid cell size (doc px, 2–1024)";
        readonly ja: "メイングリッドのサイズ（docピクセル、2–1024）";
        readonly tok: "suli pi kulupu leko (px 2–1024)";
    };
    readonly "menu.genAI": {
        readonly zh: "启用生成式 AI 功能";
        readonly en: "Enable generative AI";
        readonly ja: "生成 AI 機能を有効化";
        readonly tok: "o ken e ilo sona";
    };
    readonly "status.genAI": {
        readonly zh: "生成式 AI 功能：{s}";
        readonly en: "Generative AI: {s}";
        readonly ja: "生成 AI 機能：{s}";
        readonly tok: "ilo sona: {s}";
    };
    readonly "menu.theme": {
        readonly zh: "主题";
        readonly en: "Theme";
        readonly ja: "テーマ";
        readonly tok: "nasin kule";
    };
    readonly "menu.language": {
        readonly zh: "语言";
        readonly en: "Language";
        readonly ja: "言語";
        readonly tok: "toki";
    };
    readonly "menu.shortcuts": {
        readonly zh: "快捷键";
        readonly en: "Shortcuts";
        readonly ja: "ショートカット";
        readonly tok: "nena pi tenpo lili";
    };
    readonly "menu.timelapse": {
        readonly zh: "过程录像…";
        readonly en: "Timelapse…";
        readonly ja: "タイムラプス…";
        readonly tok: "sitelen tawa…";
    };
    readonly "tl.title": {
        readonly zh: "过程录像";
        readonly en: "Timelapse";
        readonly ja: "タイムラプス";
        readonly tok: "sitelen tawa";
    };
    readonly "tl.rec": {
        readonly zh: "录制中";
        readonly en: "REC";
        readonly ja: "録画中";
        readonly tok: "lukin";
    };
    readonly "tl.aspect": {
        readonly zh: "画幅比例";
        readonly en: "Aspect ratio";
        readonly ja: "アスペクト比";
    };
    readonly "tl.longEdge": {
        readonly zh: "分辨率（最长边）";
        readonly en: "Resolution (long edge)";
        readonly ja: "解像度（長辺）";
    };
    readonly "tl.start": {
        readonly zh: "开始录制";
        readonly en: "Start recording";
        readonly ja: "録画開始";
        readonly tok: "o open lukin";
    };
    readonly "tl.pause": {
        readonly zh: "暂停";
        readonly en: "Pause";
        readonly ja: "一時停止";
    };
    readonly "tl.resume": {
        readonly zh: "继续录制";
        readonly en: "Resume";
        readonly ja: "再開";
    };
    readonly "tl.preview": {
        readonly zh: "预览";
        readonly en: "Preview";
        readonly ja: "プレビュー";
    };
    readonly "tl.export": {
        readonly zh: "导出视频";
        readonly en: "Export video";
        readonly ja: "動画を書き出す";
    };
    readonly "tl.clear": {
        readonly zh: "清除录像…";
        readonly en: "Clear recording…";
        readonly ja: "録画を消去…";
    };
    readonly "tl.clearConfirmTitle": {
        readonly zh: "清除录像";
        readonly en: "Clear recording";
        readonly ja: "録画を消去";
    };
    readonly "tl.clearConfirmMsg": {
        readonly zh: "已录的过程视频将被删除。此操作无法撤销（画作本身不受影响）。";
        readonly en: "The recorded footage will be deleted. This cannot be undone (your artwork is unaffected).";
        readonly ja: "録画した映像を削除します。この操作は元に戻せません（作品自体は影響を受けません）。";
    };
    readonly "tl.state.recording": {
        readonly zh: "录制中";
        readonly en: "Recording";
        readonly ja: "録画中";
    };
    readonly "tl.state.paused": {
        readonly zh: "已暂停";
        readonly en: "Paused";
        readonly ja: "一時停止中";
    };
    readonly "tl.state.off": {
        readonly zh: "未录制";
        readonly en: "Off";
        readonly ja: "未録画";
    };
    readonly "tl.pendingFrames": {
        readonly zh: "{n} 帧待保存";
        readonly en: "{n} frames pending save";
        readonly ja: "{n}フレーム保存待ち";
    };
    readonly "tl.lockedNote": {
        readonly zh: "画幅与分辨率在开录时锁定；要更改请清除后重录。";
        readonly en: "Aspect and resolution are locked when recording starts; clear the recording to change them.";
        readonly ja: "アスペクト比と解像度は録画開始時に固定されます。変更するには消去して録り直してください。";
    };
    readonly "tl.unsupported": {
        readonly zh: "此设备不支持视频编码（WebCodecs）";
        readonly en: "Video encoding (WebCodecs) is not supported on this device";
        readonly ja: "このデバイスは動画エンコード（WebCodecs）非対応です";
    };
    readonly "tl.probing": {
        readonly zh: "正在检测设备编码能力…";
        readonly en: "Checking encoder support…";
        readonly ja: "エンコーダー対応を確認中…";
    };
    readonly "tl.restoreLost": {
        readonly zh: "过程录像数据损坏，已重置（画作不受影响）";
        readonly en: "Timelapse footage was corrupted and has been reset (artwork unaffected)";
        readonly ja: "タイムラプスのデータが破損していたためリセットしました（作品は無事です）";
    };
    readonly "tl.captureHalted": {
        readonly zh: "过程录像已暂停（编码器故障，已录素材已保留）";
        readonly en: "Timelapse paused (encoder failure; existing footage kept)";
        readonly ja: "タイムラプスを一時停止しました（エンコーダー障害・既存の映像は保持）";
    };
    readonly "menu.resetRack": {
        readonly zh: "还原内置笔刷…";
        readonly en: "Restore built-in brushes…";
        readonly ja: "内蔵ブラシを復元…";
        readonly tok: "o kama sin e ilo pi tan open…";
    };
    readonly "menu.forceReset": {
        readonly zh: "强制更新";
        readonly en: "Force update";
        readonly ja: "強制更新";
        readonly tok: "o sin wawa e mi";
    };
    readonly "menu.smoothDev": {
        readonly zh: "平滑调参（dev）";
        readonly en: "Smoothing tuning (dev)";
        readonly ja: "スムージング調整（dev）";
        readonly tok: "nasin pi linja pona (\"dev\")";
    };
    readonly "menu.fps": {
        readonly zh: "FPS 计";
        readonly en: "FPS meter";
        readonly ja: "FPS 表示";
        readonly tok: "nanpa pi sitelen tawa";
    };
    readonly "menu.version": {
        readonly zh: "{v}";
        readonly en: "{v}";
        readonly ja: "{v}";
        readonly tok: "{v}";
    };
    readonly "theme.auto": {
        readonly zh: "跟随系统";
        readonly en: "System";
        readonly ja: "システムに従う";
        readonly tok: "sama tenpo";
    };
    readonly "theme.day": {
        readonly zh: "日";
        readonly en: "Light";
        readonly ja: "ライト";
        readonly tok: "suno";
    };
    readonly "theme.night": {
        readonly zh: "夜";
        readonly en: "Dark";
        readonly ja: "ダーク";
        readonly tok: "pimeja";
    };
    readonly "common.on": {
        readonly zh: "开";
        readonly en: "On";
        readonly ja: "オン";
        readonly tok: "lon";
    };
    readonly "common.off": {
        readonly zh: "关";
        readonly en: "Off";
        readonly ja: "オフ";
        readonly tok: "ala";
    };
    readonly "common.ok": {
        readonly zh: "确定";
        readonly en: "OK";
        readonly ja: "OK";
        readonly tok: "pona";
    };
    readonly "common.cancel": {
        readonly zh: "取消";
        readonly en: "Cancel";
        readonly ja: "キャンセル";
        readonly tok: "weka";
    };
    readonly "common.notice": {
        readonly zh: "提示";
        readonly en: "Notice";
        readonly ja: "お知らせ";
        readonly tok: "toki";
    };
    readonly "common.close.aria": {
        readonly zh: "关闭";
        readonly en: "Close";
        readonly ja: "閉じる";
        readonly tok: "pini";
    };
    readonly "common.apply": {
        readonly zh: "应用";
        readonly en: "Apply";
        readonly ja: "適用";
        readonly tok: "o kepeken";
    };
    readonly "common.save": {
        readonly zh: "保存";
        readonly en: "Save";
        readonly ja: "保存";
        readonly tok: "awen";
    };
    readonly "common.reset": {
        readonly zh: "重置";
        readonly en: "Reset";
        readonly ja: "リセット";
        readonly tok: "kama sin";
    };
    readonly "common.exit": {
        readonly zh: "退出";
        readonly en: "Exit";
        readonly ja: "終了";
        readonly tok: "weka";
    };
    readonly "common.custom": {
        readonly zh: "自定义";
        readonly en: "Custom";
        readonly ja: "カスタム";
        readonly tok: "nasin sina";
    };
    readonly "status.ready": {
        readonly zh: "就绪";
        readonly en: "Ready";
        readonly ja: "準備完了";
        readonly tok: "pona";
    };
    readonly "status.checkerboard": {
        readonly zh: "透明棋盘 · {s}";
        readonly en: "Checkerboard · {s}";
        readonly ja: "市松模様 · {s}";
        readonly tok: "leko pi kule kon · {s}";
    };
    readonly "status.longPressPick": {
        readonly zh: "长按吸色 · {s}";
        readonly en: "Long-press pick · {s}";
        readonly ja: "長押しスポイト · {s}";
        readonly tok: "luka awen li kama e kule · {s}";
    };
    readonly "status.singleFingerDraw": {
        readonly zh: "单指绘画 · {s}";
        readonly en: "One-finger draw · {s}";
        readonly ja: "一本指描画 · {s}";
        readonly tok: "luka wan li sitelen · {s}";
    };
    readonly "status.pixelGrid": {
        readonly zh: "像素栅格 · {s}";
        readonly en: "Pixel grid · {s}";
        readonly ja: "ピクセルグリッド · {s}";
        readonly tok: "kulupu leko lili · {s}";
    };
    readonly "status.docGrid": {
        readonly zh: "主栅格 · {s}";
        readonly en: "Main grid · {s}";
        readonly ja: "メイングリッド · {s}";
        readonly tok: "kulupu leko suli · {s}";
    };
    readonly "status.docGridCell": {
        readonly zh: "主栅格尺寸 · {n}px";
        readonly en: "Main grid size · {n}px";
        readonly ja: "メイングリッドのサイズ · {n}px";
        readonly tok: "suli pi kulupu leko · {n}px";
    };
    readonly "status.fps": {
        readonly zh: "FPS 计 · {s}";
        readonly en: "FPS meter · {s}";
        readonly ja: "FPS 表示 · {s}";
        readonly tok: "nanpa pi sitelen tawa · {s}";
    };
    readonly "status.theme": {
        readonly zh: "主题 · {s}";
        readonly en: "Theme · {s}";
        readonly ja: "テーマ · {s}";
        readonly tok: "nasin kule · {s}";
    };
    readonly "menu.tab.file": {
        readonly zh: "文件";
        readonly en: "File";
        readonly ja: "ファイル";
        readonly tok: "sitelen";
    };
    readonly "menu.tab.canvas": {
        readonly zh: "画布";
        readonly en: "Canvas";
        readonly ja: "キャンバス";
        readonly tok: "supa";
    };
    readonly "menu.tab.view": {
        readonly zh: "视图";
        readonly en: "View";
        readonly ja: "表示";
        readonly tok: "lukin";
    };
    readonly "menu.tab.settings": {
        readonly zh: "设置";
        readonly en: "Settings";
        readonly ja: "設定";
        readonly tok: "nasin";
    };
    readonly "menu.tab.plugins": {
        readonly zh: "插件";
        readonly en: "Plugins";
        readonly ja: "プラグイン";
        readonly tok: "ilo namako";
    };
    readonly "menu.tab.dev": {
        readonly zh: "dev";
        readonly en: "dev";
        readonly ja: "dev";
        readonly tok: "\"dev\"";
    };
    readonly "menu.exportImage": {
        readonly zh: "导出";
        readonly en: "Export";
        readonly ja: "書き出す";
        readonly tok: "o pana";
    };
    readonly "menu.rename": {
        readonly zh: "重命名当前画作…";
        readonly en: "Rename artwork…";
        readonly ja: "作品名を変更…";
        readonly tok: "ante nimi…";
    };
    readonly "menu.saveAs": {
        readonly zh: "另存为…";
        readonly en: "Save as…";
        readonly ja: "名前を付けて保存…";
        readonly tok: "awen kepeken nimi sin…";
    };
    readonly "menu.revert": {
        readonly zh: "撤销修改…";
        readonly en: "Revert changes…";
        readonly ja: "変更を取り消す…";
        readonly tok: "kama sin tawa tenpo pini…";
    };
    readonly "menu.encrypt": {
        readonly zh: "加密保护…";
        readonly en: "Encrypt…";
        readonly ja: "暗号化…";
        readonly tok: "len…";
    };
    readonly "menu.decrypt": {
        readonly zh: "解除加密…";
        readonly en: "Decrypt…";
        readonly ja: "暗号化を解除…";
        readonly tok: "weka len…";
    };
    readonly "menu.cropToSelection": {
        readonly zh: "裁切到选区";
        readonly en: "Crop to selection";
        readonly ja: "選択範囲で切り抜き";
        readonly tok: "o kipisi tawa ma wile";
    };
    readonly "menu.cropFree": {
        readonly zh: "裁切…";
        readonly en: "Crop…";
        readonly ja: "切り抜き…";
        readonly tok: "kipisi…";
    };
    readonly "menu.flipH": {
        readonly zh: "水平翻转";
        readonly en: "Flip horizontal";
        readonly ja: "左右反転";
        readonly tok: "o jasima e poka";
    };
    readonly "menu.rotate90": {
        readonly zh: "逆时针旋转 90°";
        readonly en: "Rotate 90° CCW";
        readonly ja: "反時計回りに90°回転";
        readonly tok: "o sike (90°)";
    };
    readonly "menu.offset": {
        readonly zh: "偏移接缝（环绕）…";
        readonly en: "Offset seam (wrap)…";
        readonly ja: "シームをずらす（ラップ）…";
        readonly tok: "tawa sike…";
    };
    readonly "menu.resample": {
        readonly zh: "调整尺寸";
        readonly en: "Resize";
        readonly ja: "サイズ変更";
        readonly tok: "ante suli";
    };
    readonly "menu.reference": {
        readonly zh: "参考小窗";
        readonly en: "Reference window";
        readonly ja: "参考ウィンドウ";
        readonly tok: "lupa lukin";
    };
    readonly "menu.fit": {
        readonly zh: "视口复位";
        readonly en: "Reset view";
        readonly ja: "ビューをリセット";
        readonly tok: "o kama sin e lukin";
    };
    readonly "menu.config.exportImage": {
        readonly zh: "配置导出";
        readonly en: "Export settings";
        readonly ja: "書き出し設定";
        readonly tok: "nasin pana";
    };
    readonly "sub.activeLayer": {
        readonly zh: "当前层";
        readonly en: "Active layer";
        readonly ja: "アクティブ層";
        readonly tok: "lipu ni";
    };
    readonly "sub.merged": {
        readonly zh: "合并";
        readonly en: "Merged";
        readonly ja: "統合";
        readonly tok: "wan pi lipu ale";
    };
    readonly "sub.clipboard": {
        readonly zh: "剪切板";
        readonly en: "Clipboard";
        readonly ja: "クリップボード";
        readonly tok: "poki kipisi";
    };
    readonly "sub.print": {
        readonly zh: "打印";
        readonly en: "Print";
        readonly ja: "印刷";
        readonly tok: "ilo lipu";
    };
    readonly "sub.file": {
        readonly zh: "文件";
        readonly en: "File";
        readonly ja: "ファイル";
        readonly tok: "lipu";
    };
    readonly "sub.newLayer": {
        readonly zh: "新图层";
        readonly en: "New layer";
        readonly ja: "新規レイヤー";
        readonly tok: "lipu sin";
    };
    readonly "save.none": {
        readonly zh: "未打开作品";
        readonly en: "No artwork open";
        readonly ja: "作品が開かれていません";
        readonly tok: "sitelen li lon ala";
    };
    readonly "save.dirty": {
        readonly zh: "保存 + 推送 (Ctrl+S) · {name} · 未保存";
        readonly en: "Save + push (Ctrl+S) · {name} · unsaved";
        readonly ja: "保存＋アップロード (Ctrl+S) · {name} · 未保存";
        readonly tok: "o awen (Ctrl+S) · {name} · awen ala";
    };
    readonly "save.synced": {
        readonly zh: "已同步云端（上次保存时）· 点击检查是否有新版本 · {name}";
        readonly en: "Synced to cloud (at last save) · tap to check for newer · {name}";
        readonly ja: "クラウド同期済み（前回保存時）· タップで更新確認 · {name}";
        readonly tok: "sitelen li lon poki sewi · sina luka la mi alasa e sin · {name}";
    };
    readonly "save.localOnly": {
        readonly zh: "已存本地（IDB 易失，登录云端更安全） · {name}";
        readonly en: "Saved locally (IDB is volatile; sign in for safety) · {name}";
        readonly ja: "ローカル保存済み（IDBは揮発性、クラウド推奨） · {name}";
        readonly tok: "sitelen li awen lon ilo ni taso · poki sewi li awen pona · {name}";
    };
    readonly "save.unpushed": {
        readonly zh: "已存本地，未上云（点击重试推送） · {name}";
        readonly en: "Saved locally, not uploaded (tap to retry) · {name}";
        readonly ja: "ローカル保存済み、クラウド未送信（タップで再試行） · {name}";
        readonly tok: "awen lon ilo ni · pana tawa poki sewi li pakala · sina luka la mi pana sin · {name}";
    };
    readonly "mode.normal": {
        readonly zh: "正常";
        readonly en: "Normal";
        readonly ja: "通常";
        readonly tok: "sama";
    };
    readonly "mode.multiply": {
        readonly zh: "正片叠底";
        readonly en: "Multiply";
        readonly ja: "乗算";
        readonly tok: "pimeja kule";
    };
    readonly "mode.screen": {
        readonly zh: "滤色";
        readonly en: "Screen";
        readonly ja: "スクリーン";
        readonly tok: "walo kule";
    };
    readonly "mode.overlay": {
        readonly zh: "叠加";
        readonly en: "Overlay";
        readonly ja: "オーバーレイ";
        readonly tok: "pimeja walo";
    };
    readonly "mode.darken": {
        readonly zh: "变暗";
        readonly en: "Darken";
        readonly ja: "比較（暗）";
        readonly tok: "pimeja";
    };
    readonly "mode.lighten": {
        readonly zh: "变亮";
        readonly en: "Lighten";
        readonly ja: "比較（明）";
        readonly tok: "walo";
    };
    readonly "mode.colorDodge": {
        readonly zh: "颜色减淡";
        readonly en: "Color Dodge";
        readonly ja: "覆い焼きカラー";
        readonly tok: "walo wawa";
    };
    readonly "mode.colorBurn": {
        readonly zh: "颜色加深";
        readonly en: "Color Burn";
        readonly ja: "焼き込みカラー";
        readonly tok: "pimeja wawa";
    };
    readonly "mode.hardLight": {
        readonly zh: "强光";
        readonly en: "Hard Light";
        readonly ja: "ハードライト";
        readonly tok: "suno kiwen";
    };
    readonly "mode.softLight": {
        readonly zh: "柔光";
        readonly en: "Soft Light";
        readonly ja: "ソフトライト";
        readonly tok: "suno ko";
    };
    readonly "mode.difference": {
        readonly zh: "差值";
        readonly en: "Difference";
        readonly ja: "差の絶対値";
        readonly tok: "ante";
    };
    readonly "mode.exclusion": {
        readonly zh: "排除";
        readonly en: "Exclusion";
        readonly ja: "除外";
        readonly tok: "ante lili";
    };
    readonly "mode.passThrough": {
        readonly zh: "穿透";
        readonly en: "Pass Through";
        readonly ja: "パススルー";
        readonly tok: "lupa";
    };
    readonly "lp.badge": {
        readonly zh: "不透明度 {o}% · 模式 {m}";
        readonly en: "Opacity {o}% · Mode {m}";
        readonly ja: "不透明度 {o}% · モード {m}";
        readonly tok: "wawa kule {o}% · nasin {m}";
    };
    readonly "lp.visible": {
        readonly zh: "可见";
        readonly en: "Visible";
        readonly ja: "表示";
        readonly tok: "lukin";
    };
    readonly "lp.hidden": {
        readonly zh: "已隐藏";
        readonly en: "Hidden";
        readonly ja: "非表示";
        readonly tok: "lukin ala";
    };
    readonly "lp.expandGroup": {
        readonly zh: "展开组";
        readonly en: "Expand group";
        readonly ja: "グループを展開";
        readonly tok: "o open e kulupu";
    };
    readonly "lp.collapseGroup": {
        readonly zh: "折叠组";
        readonly en: "Collapse group";
        readonly ja: "グループを折りたたむ";
        readonly tok: "o pini e kulupu";
    };
    readonly "lp.clippedTip": {
        readonly zh: "已剪裁到下方第一颗非剪裁层";
        readonly en: "Clipped to first non-clip layer below";
        readonly ja: "下の最初の非クリップ層にクリップ";
        readonly tok: "lipu ni li lon insa pi lipu anpa";
    };
    readonly "lp.lockAlphaTip": {
        readonly zh: "锁定不透明度：笔只改已有像素的颜色";
        readonly en: "Lock alpha: brush only recolors existing pixels";
        readonly ja: "不透明度をロック：既存ピクセルの色のみ変更";
        readonly tok: "ilo sitelen li ken kule e ma sitelen taso. ma ante li awen kon.";
    };
    readonly "fm.commit": {
        readonly zh: "填充并清除选区";
        readonly en: "Fill and clear selection";
        readonly ja: "塗りつぶして選択解除";
        readonly tok: "o kule e ma wile o weka e ona";
    };
    readonly "fm.commitFailed": {
        readonly zh: "填充提交失败";
        readonly en: "Fill commit failed";
        readonly ja: "塗りつぶしの確定に失敗しました";
        readonly tok: "pali kule li pakala";
    };
    readonly "fm.exitNoFill": {
        readonly zh: "未填充（图层不可编辑），选区已清除";
        readonly en: "Not filled (layer not editable) — selection cleared";
        readonly ja: "塗りつぶし未実行（レイヤーは編集不可）。選択を解除しました";
        readonly tok: "kule ala (lipu li ken ala ante) — ma wile li weka";
    };
    readonly "lp.refTip": {
        readonly zh: "参考层：魔棒 / 填充读这一层";
        readonly en: "Reference layer: magic wand / fill read this layer";
        readonly ja: "参照レイヤー：自動選択 / 塗りつぶしがこの層を参照";
        readonly tok: "lipu lukin: ilo pi ma sama en ilo pi kule ma li lukin e lipu ni";
    };
    readonly "lp.layerMenu": {
        readonly zh: "图层菜单";
        readonly en: "Layer menu";
        readonly ja: "レイヤーメニュー";
        readonly tok: "nasin lipu";
    };
    readonly "lp.rename": {
        readonly zh: "重命名…";
        readonly en: "Rename…";
        readonly ja: "名前を変更…";
        readonly tok: "ante nimi…";
    };
    readonly "lp.duplicate": {
        readonly zh: "复制图层";
        readonly en: "Duplicate layer";
        readonly ja: "レイヤーを複製";
        readonly tok: "o pali e lipu sama";
    };
    readonly "lp.ungroup": {
        readonly zh: "解组";
        readonly en: "Ungroup";
        readonly ja: "グループ解除";
        readonly tok: "o tu e kulupu";
    };
    readonly "lp.moveIntoGroup": {
        readonly zh: "移入图层组";
        readonly en: "Move into group";
        readonly ja: "グループへ移動";
        readonly tok: "tawa insa kulupu";
    };
    readonly "lp.choose": {
        readonly zh: "选择…";
        readonly en: "Choose…";
        readonly ja: "選択…";
        readonly tok: "o wile…";
    };
    readonly "lp.moveOut": {
        readonly zh: "移出组";
        readonly en: "Move out of group";
        readonly ja: "グループから出す";
        readonly tok: "tawa selo kulupu";
    };
    readonly "lp.lockAlpha": {
        readonly zh: "锁定不透明度";
        readonly en: "Lock alpha";
        readonly ja: "不透明度をロック";
        readonly tok: "ma sitelen taso";
    };
    readonly "lp.clip": {
        readonly zh: "剪裁";
        readonly en: "Clip";
        readonly ja: "クリップ";
        readonly tok: "insa anpa";
    };
    readonly "lp.clipGroup": {
        readonly zh: "剪裁组";
        readonly en: "Clip group";
        readonly ja: "グループをクリップ";
        readonly tok: "insa anpa (kulupu)";
    };
    readonly "lp.refLayer": {
        readonly zh: "参考层";
        readonly en: "Reference layer";
        readonly ja: "参照レイヤー";
        readonly tok: "lipu lukin";
    };
    readonly "lp.mergeDown": {
        readonly zh: "向下合并";
        readonly en: "Merge down";
        readonly ja: "下のレイヤーと結合";
        readonly tok: "o wan e lipu anpa";
    };
    readonly "lp.explodeColors": {
        readonly zh: "按颜色拆分";
        readonly en: "Split by color";
        readonly ja: "色で分解";
        readonly tok: "o tu e lipu kepeken kule";
    };
    readonly "lp.clearContent": {
        readonly zh: "清空内容";
        readonly en: "Clear contents";
        readonly ja: "内容を消去";
        readonly tok: "o weka e insa";
    };
    readonly "lp.delGroup": {
        readonly zh: "删除组";
        readonly en: "Delete group";
        readonly ja: "グループを削除";
        readonly tok: "o weka e kulupu";
    };
    readonly "lp.del": {
        readonly zh: "删除";
        readonly en: "Delete";
        readonly ja: "削除";
        readonly tok: "o weka";
    };
    readonly "lp.opa": {
        readonly zh: "透";
        readonly en: "Opac";
        readonly ja: "透";
        readonly tok: "kon";
    };
    readonly "lp.mode": {
        readonly zh: "模式";
        readonly en: "Mode";
        readonly ja: "モード";
        readonly tok: "nasin";
    };
    readonly "lp.st.maxLayers": {
        readonly zh: "图层数已达上限 {n}";
        readonly en: "Layer limit reached: {n}";
        readonly ja: "レイヤー数が上限 {n} に達しました";
        readonly tok: "lipu li mute sewi ({n}). lipu sin li ken ala kama.";
    };
    readonly "lp.st.restoredGroup": {
        readonly zh: "已恢复组「{name}」";
        readonly en: "Restored group “{name}”";
        readonly ja: "グループ「{name}」を復元";
        readonly tok: "kulupu \"{name}\" li kama sin";
    };
    readonly "lp.collapseToLayer": {
        readonly zh: "合并组为一层";
        readonly en: "Flatten group to layer";
        readonly ja: "グループを1レイヤーに統合";
        readonly tok: "o wan e kulupu tawa lipu wan";
    };
    readonly "lp.st.collapsedGroup": {
        readonly zh: "已把组「{name}」合并为一层";
        readonly en: "Flattened group “{name}” to a layer";
        readonly ja: "グループ「{name}」を1レイヤーに統合しました";
        readonly tok: "kulupu \"{name}\" li kama lipu wan";
    };
    readonly "lp.st.glNeeded": {
        readonly zh: "合成需要 WebGL2，当前不可用";
        readonly en: "Compositing needs WebGL2, which is unavailable";
        readonly ja: "合成には WebGL2 が必要ですが利用できません";
        readonly tok: "wan lipu li wile e ilo \"WebGL2\". taso ilo ni li lon ala.";
    };
    readonly "lp.st.stamped": {
        readonly zh: "已合并全部为新层（其他图层已隐藏）";
        readonly en: "Collapsed all into a new layer (others hidden)";
        readonly ja: "すべてを結合して新規レイヤーにしました（他は非表示）";
        readonly tok: "mi wan e lipu ale tawa lipu sin. lipu ante li kama lukin ala.";
    };
    readonly "lp.st.unstamped": {
        readonly zh: "已撤销合并";
        readonly en: "Collapse undone";
        readonly ja: "結合を取り消しました";
        readonly tok: "wan li weka";
    };
    readonly "doc.layerName": {
        readonly zh: "图层";
        readonly en: "Layer";
        readonly ja: "レイヤー";
        readonly tok: "lipu";
    };
    readonly "doc.copySuffix": {
        readonly zh: "副本";
        readonly en: "copy";
        readonly ja: "コピー";
        readonly tok: "sama";
    };
    readonly "doc.stampName": {
        readonly zh: "合并";
        readonly en: "Merged";
        readonly ja: "統合";
        readonly tok: "lipu wan";
    };
    readonly "lp.st.exploded": {
        readonly zh: "已把「{name}」按颜色拆分为 {k} 层";
        readonly en: "Split “{name}” into {k} layers by color";
        readonly ja: "「{name}」を色で {k} レイヤーに分解しました";
        readonly tok: "lipu \"{name}\" li kama lipu {k} kepeken kule";
    };
    readonly "lp.st.unexploded": {
        readonly zh: "已还原拆分：「{name}」";
        readonly en: "Split undone: “{name}”";
        readonly ja: "分解を取り消しました：「{name}」";
        readonly tok: "tu li weka: \"{name}\"";
    };
    readonly "ex.title": {
        readonly zh: "按颜色拆分图层";
        readonly en: "Split layer by color";
        readonly ja: "レイヤーを色で分解";
        readonly tok: "o tu e lipu kepeken kule";
    };
    readonly "ex.hint": {
        readonly zh: "像素按最近的中心色硬分配到多张新图层，叠加显示与原层一致";
        readonly en: "Each pixel goes wholly to the layer of its nearest cluster color; stacked result matches the original";
        readonly ja: "各ピクセルは最も近い中心色のレイヤーへ振り分けられます。重ねた表示は元と同じです";
        readonly tok: "leko kule ale li tawa lipu pi kule sama. lipu ale li lukin sama lipu open.";
    };
    readonly "ex.k": {
        readonly zh: "颜色数";
        readonly en: "Colors";
        readonly ja: "色数";
        readonly tok: "nanpa kule";
    };
    readonly "ex.commit": {
        readonly zh: "拆分";
        readonly en: "Split";
        readonly ja: "分解";
        readonly tok: "o tu";
    };
    readonly "ex.empty": {
        readonly zh: "图层没有可拆分的内容";
        readonly en: "Layer has nothing to split";
        readonly ja: "分解できる内容がありません";
        readonly tok: "lipu li jo e ala";
    };
    readonly "ex.culture": {
        readonly zh: "色名词库";
        readonly en: "Color names";
        readonly ja: "色名辞典";
        readonly tok: "nimi kule";
    };
    readonly "ex.tooMany": {
        readonly zh: "图层数已接近上限 {n}，放不下拆分结果";
        readonly en: "Too close to the layer limit ({n}) to split";
        readonly ja: "レイヤー上限 {n} に近く、分解結果を置けません";
        readonly tok: "lipu li mute sewi ({n}). tu li ken ala.";
    };
    readonly "lp.st.deletedGroup": {
        readonly zh: "已删除组「{name}」";
        readonly en: "Deleted group “{name}”";
        readonly ja: "グループ「{name}」を削除";
        readonly tok: "kulupu \"{name}\" li weka";
    };
    readonly "lp.st.mergeIntoGroup": {
        readonly zh: "下方是图层组，不能合并进去";
        readonly en: "Below is a group — can't merge into it";
        readonly ja: "下がグループのため結合できません";
        readonly tok: "anpa li kulupu. wan li ken ala.";
    };
    readonly "lp.st.keepOne": {
        readonly zh: "至少保留一层";
        readonly en: "Keep at least one layer";
        readonly ja: "最低1レイヤーは必要です";
        readonly tok: "lipu wan li wile awen";
    };
    readonly "lp.st.newGroup": {
        readonly zh: "已新建组「{name}」";
        readonly en: "Created group “{name}”";
        readonly ja: "グループ「{name}」を作成";
        readonly tok: "kulupu sin li lon: \"{name}\"";
    };
    readonly "lp.st.newGroupColon": {
        readonly zh: "已新建图层组：{name}";
        readonly en: "New layer group: {name}";
        readonly ja: "新規グループ：{name}";
        readonly tok: "kulupu sin li lon: {name}";
    };
    readonly "lp.st.regrouped": {
        readonly zh: "已重新编组";
        readonly en: "Regrouped";
        readonly ja: "再グループ化しました";
        readonly tok: "kulupu li sin";
    };
    readonly "lp.st.ungrouped": {
        readonly zh: "已解组";
        readonly en: "Ungrouped";
        readonly ja: "グループを解除しました";
        readonly tok: "kulupu li tu";
    };
    readonly "lp.st.ungroupedName": {
        readonly zh: "已解组：{name}";
        readonly en: "Ungrouped: {name}";
        readonly ja: "グループ解除：{name}";
        readonly tok: "kulupu li tu: {name}";
    };
    readonly "lp.st.movedOut": {
        readonly zh: "已移出组";
        readonly en: "Moved out of group";
        readonly ja: "グループから出しました";
        readonly tok: "lipu li tawa selo kulupu";
    };
    readonly "lp.st.movedIn": {
        readonly zh: "已移入组";
        readonly en: "Moved into group";
        readonly ja: "グループへ移動しました";
        readonly tok: "lipu li tawa insa kulupu";
    };
    readonly "lp.st.movedBack": {
        readonly zh: "已移回组";
        readonly en: "Moved back into group";
        readonly ja: "グループに戻しました";
        readonly tok: "lipu li kama sin lon kulupu";
    };
    readonly "lp.st.movedInColon": {
        readonly zh: "已移入组：{name}";
        readonly en: "Moved into group: {name}";
        readonly ja: "グループへ移動：{name}";
        readonly tok: "lipu li tawa insa kulupu: {name}";
    };
    readonly "lp.st.movedOutColon": {
        readonly zh: "已移出组：{name}";
        readonly en: "Moved out of group: {name}";
        readonly ja: "グループから出す：{name}";
        readonly tok: "lipu li tawa selo kulupu: {name}";
    };
    readonly "lp.st.alreadyEmpty": {
        readonly zh: "图层已经是空的";
        readonly en: "Layer is already empty";
        readonly ja: "レイヤーは既に空です";
        readonly tok: "lipu li jo e ala";
    };
    readonly "lp.st.cleared": {
        readonly zh: "已清空：{name}";
        readonly en: "Cleared: {name}";
        readonly ja: "消去：{name}";
        readonly tok: "insa li weka: {name}";
    };
    readonly "lp.st.duplicated": {
        readonly zh: "已复制：{name}";
        readonly en: "Duplicated: {name}";
        readonly ja: "複製：{name}";
        readonly tok: "lipu sama li lon: {name}";
    };
    readonly "lp.st.mergeBottom": {
        readonly zh: "已经是最底层，没法向下合";
        readonly en: "Already the bottom layer, can't merge down";
        readonly ja: "最下層です。下と結合できません";
        readonly tok: "lipu ni li anpa ale la wan anpa li ken ala";
    };
    readonly "lp.st.mergeClipUnder": {
        readonly zh: "下方是剪裁层，不能合到它上面（先取消下方的剪裁）";
        readonly en: "Layer below is a clip layer; cancel its clip first";
        readonly ja: "下がクリップ層です（先に下のクリップを解除）";
        readonly tok: "lipu anpa li lon insa pi lipu ante. o weka e nasin ni lon tenpo open.";
    };
    readonly "lp.st.mergeFail": {
        readonly zh: "无法向下合并";
        readonly en: "Can't merge down";
        readonly ja: "下と結合できません";
        readonly tok: "wan anpa li ken ala";
    };
    readonly "cw.svPad": {
        readonly zh: "饱和度 / 明度面板";
        readonly en: "Saturation / Value panel";
        readonly ja: "彩度 / 明度パネル";
        readonly tok: "mute kule / suno";
    };
    readonly "cw.hue": {
        readonly zh: "色相";
        readonly en: "Hue";
        readonly ja: "色相";
        readonly tok: "kule";
    };
    readonly "ld.brush": {
        readonly zh: "当前笔刷（tap 切换 / 长按编辑）";
        readonly en: "Current brush (tap to switch / long-press to edit)";
        readonly ja: "現在のブラシ（タップで切替 / 長押しで編集）";
        readonly tok: "ilo sitelen ni · luka la ante · luka awen la nasin";
    };
    readonly "ld.size": {
        readonly zh: "笔粗";
        readonly en: "Brush size";
        readonly ja: "筆の太さ";
        readonly tok: "suli linja";
    };
    readonly "ld.pressureOff": {
        readonly zh: "禁用笔压（恒定 0.5）";
        readonly en: "Disable pen pressure (constant 0.5)";
        readonly ja: "筆圧を無効化（0.5 固定）";
        readonly tok: "o weka e wawa luka (0.5 sama ale)";
    };
    readonly "ld.pressureOn": {
        readonly zh: "启用笔压";
        readonly en: "Enable pen pressure";
        readonly ja: "筆圧を有効化";
        readonly tok: "o kama sin e wawa luka";
    };
    readonly "status.pressureOff": {
        readonly zh: "已禁用笔压（恒定 0.5）";
        readonly en: "Pen pressure disabled (constant 0.5)";
        readonly ja: "筆圧を無効化しました（0.5 固定）";
        readonly tok: "wawa luka li weka (0.5 sama ale)";
    };
    readonly "status.pressureOn": {
        readonly zh: "已恢复笔压";
        readonly en: "Pen pressure restored";
        readonly ja: "筆圧を有効化しました";
        readonly tok: "wawa luka li kama sin";
    };
    readonly "ld.opacity": {
        readonly zh: "不透明度";
        readonly en: "Opacity";
        readonly ja: "不透明度";
        readonly tok: "wawa kule";
    };
    readonly "rs.rackEmpty": {
        readonly zh: "笔架是空的——内置笔刷可能还没加载好（离线时会自动重试）。";
        readonly en: "The rack is empty — the built-in brushes may not have loaded yet (it retries automatically when offline).";
        readonly ja: "ブラシ棚が空です — 内蔵ブラシがまだ読み込めていない可能性があります（オフライン時は自動で再試行します）。";
        readonly tok: "poki pi ilo sitelen li jo e ala. ilo pi tan open li kama ala lon tenpo ni. mi alasa sin e ona.";
    };
    readonly "rs.resetRack": {
        readonly zh: "还原内置笔刷";
        readonly en: "Restore built-in brushes";
        readonly ja: "内蔵ブラシを復元";
        readonly tok: "o kama sin e ilo pi tan open";
    };
    readonly "rs.empty": {
        readonly zh: "此工具暂无笔刷。点「+ 新建」加一个。";
        readonly en: "No brushes for this tool. Tap “+ New” to add one.";
        readonly ja: "このツールにブラシがありません。「+ 新規」で追加。";
        readonly tok: "ilo ni li jo e ilo sitelen ala. o luka e \"+ sin\".";
    };
    readonly "rs.edit": {
        readonly zh: "编辑";
        readonly en: "Edit";
        readonly ja: "編集";
        readonly tok: "ante";
    };
    readonly "bs.basic": {
        readonly zh: "基本";
        readonly en: "Basic";
        readonly ja: "基本";
        readonly tok: "open";
    };
    readonly "bs.name": {
        readonly zh: "名字";
        readonly en: "Name";
        readonly ja: "名前";
        readonly tok: "nimi";
    };
    readonly "bs.tool": {
        readonly zh: "工具";
        readonly en: "Tool";
        readonly ja: "ツール";
        readonly tok: "ilo";
    };
    readonly "bs.toolBrush": {
        readonly zh: "笔刷";
        readonly en: "Brush";
        readonly ja: "ブラシ";
        readonly tok: "ilo sitelen";
    };
    readonly "bs.toolEraser": {
        readonly zh: "橡皮";
        readonly en: "Eraser";
        readonly ja: "消しゴム";
        readonly tok: "ilo weka";
    };
    readonly "bs.blendMode": {
        readonly zh: "混合模式";
        readonly en: "Blend mode";
        readonly ja: "描画モード";
        readonly tok: "nasin pi wan anpa";
    };
    readonly "bs.folder": {
        readonly zh: "文件夹";
        readonly en: "Folder";
        readonly ja: "フォルダ";
        readonly tok: "poki";
    };
    readonly "bs.shape": {
        readonly zh: "形状";
        readonly en: "Shape";
        readonly ja: "形状";
        readonly tok: "selo";
    };
    readonly "bs.shapeKind": {
        readonly zh: "类型";
        readonly en: "Type";
        readonly ja: "種類";
        readonly tok: "nasin";
    };
    readonly "bs.round": {
        readonly zh: "圆";
        readonly en: "Round";
        readonly ja: "円";
        readonly tok: "sike";
    };
    readonly "bs.ellipse": {
        readonly zh: "椭圆";
        readonly en: "Ellipse";
        readonly ja: "楕円";
        readonly tok: "sike palisa";
    };
    readonly "bs.aspect": {
        readonly zh: "长短轴";
        readonly en: "Aspect";
        readonly ja: "縦横比";
        readonly tok: "suli poka";
    };
    readonly "bs.rotation": {
        readonly zh: "旋转°";
        readonly en: "Rotation°";
        readonly ja: "回転°";
        readonly tok: "sike (°)";
    };
    readonly "bs.hardness": {
        readonly zh: "硬度";
        readonly en: "Hardness";
        readonly ja: "硬さ";
        readonly tok: "kiwen";
    };
    readonly "bs.sizeTitle": {
        readonly zh: "粗细 (size)";
        readonly en: "Size";
        readonly ja: "サイズ (size)";
        readonly tok: "suli linja (size)";
    };
    readonly "bs.sizeBase": {
        readonly zh: "基础";
        readonly en: "Base";
        readonly ja: "基本";
        readonly tok: "open";
    };
    readonly "bs.sizeMax": {
        readonly zh: "最大";
        readonly en: "Max";
        readonly ja: "最大";
        readonly tok: "sewi";
    };
    readonly "bs.dynamics": {
        readonly zh: "压感 (−1..1，0 = 不响应、负数 = 反向)";
        readonly en: "Pressure (−1..1; 0 = none, negative = inverted)";
        readonly ja: "筆圧 (−1..1、0 = 無効、負 = 反転)";
        readonly tok: "ante tan wawa luka (−1..1, 0 = ala, nanpa anpa = nasin ante)";
    };
    readonly "bs.defaults": {
        readonly zh: "默认值（选笔时拷给 opacity 滑块）";
        readonly en: "Defaults (copied to opacity slider on select)";
        readonly ja: "既定値（選択時に不透明度スライダーへ）";
        readonly tok: "nanpa open";
    };
    readonly "bs.defaultOpa": {
        readonly zh: "默认 opacity";
        readonly en: "Default opacity";
        readonly ja: "既定の不透明度";
        readonly tok: "\"opacity\" open";
    };
    readonly "bs.smooth": {
        readonly zh: "笔画平滑";
        readonly en: "Stroke smoothing";
        readonly ja: "ストローク補正";
        readonly tok: "linja pona";
    };
    readonly "bs.advanced": {
        readonly zh: "高级";
        readonly en: "Advanced";
        readonly ja: "詳細";
        readonly tok: "ijo insa";
    };
    readonly "bs.composite": {
        readonly zh: "重叠模式 compositeMode";
        readonly en: "Overlap (compositeMode)";
        readonly ja: "重なり (compositeMode)";
        readonly tok: "nasin pi wan linja (\"compositeMode\")";
    };
    readonly "bs.wash": {
        readonly zh: "Wash（max；自交不变深，有上限）";
        readonly en: "Wash (max; self-overlap won’t darken, capped)";
        readonly ja: "ウォッシュ（max；自己重なりで濃くならない、上限あり）";
        readonly tok: "\"Wash\" (sewi li lon. linja sama li pimeja ala.)";
    };
    readonly "bs.buildup": {
        readonly zh: "Build-Up（累积；可达 100%，喷枪 feel）";
        readonly en: "Build-Up (accumulates; up to 100%, airbrush feel)";
        readonly ja: "ビルドアップ（累積；100%まで、エアブラシ感）";
        readonly tok: "\"Build-Up\" (kule li kama mute. ken ale 100%.)";
    };
    readonly "bs.pixelModeHelp": {
        readonly zh: "开 = 整数 snap + fillRect 无 AA（像素艺术）";
        readonly en: "On = integer snap + fillRect, no AA (pixel art)";
        readonly ja: "オン = 整数スナップ + fillRect、AAなし（ドット絵）";
        readonly tok: "lon = leko kiwen (sitelen leko)";
    };
    readonly "bs.spacingTitle": {
        readonly zh: "间距 (% 直径)";
        readonly en: "Spacing (% of diameter)";
        readonly ja: "間隔 (% 直径)";
        readonly tok: "weka pi sitelen lili (% suli)";
    };
    readonly "bs.spacing": {
        readonly zh: "间距";
        readonly en: "Spacing";
        readonly ja: "間隔";
        readonly tok: "weka pi sitelen lili";
    };
    readonly "bs.taper": {
        readonly zh: "收尾";
        readonly en: "Taper";
        readonly ja: "テーパー";
        readonly tok: "pini linja";
    };
    readonly "bs.taperIn": {
        readonly zh: "入端";
        readonly en: "In";
        readonly ja: "入り";
        readonly tok: "open";
    };
    readonly "bs.taperOut": {
        readonly zh: "出端";
        readonly en: "Out";
        readonly ja: "抜き";
        readonly tok: "pini";
    };
    readonly "bs.taperFloor": {
        readonly zh: "收尾下限";
        readonly en: "Taper floor";
        readonly ja: "テーパー下限";
        readonly tok: "anpa";
    };
    readonly "bs.exportBrush": {
        readonly zh: "导出此笔为 JSON 文件";
        readonly en: "Export this brush as JSON";
        readonly ja: "このブラシをJSONで書き出す";
        readonly tok: "o pana e ilo ni tawa lipu JSON";
    };
    readonly "bs.deleteBrush": {
        readonly zh: "删除此笔";
        readonly en: "Delete this brush";
        readonly ja: "このブラシを削除";
        readonly tok: "o moli e ilo ni";
    };
    readonly "gal.loading": {
        readonly zh: "加载中…";
        readonly en: "Loading…";
        readonly ja: "読み込み中…";
        readonly tok: "o awen lili…";
    };
    readonly "gal.folder": {
        readonly zh: "文件夹";
        readonly en: "Folder";
        readonly ja: "フォルダ";
        readonly tok: "poki";
    };
    readonly "gal.emptyFolder": {
        readonly zh: "空文件夹";
        readonly en: "Empty folder";
        readonly ja: "空のフォルダ";
        readonly tok: "poki pi jo ala";
    };
    readonly "gal.more": {
        readonly zh: "更多操作";
        readonly en: "More actions";
        readonly ja: "その他の操作";
        readonly tok: "ijo ante";
    };
    readonly "gal.lockedThumb": {
        readonly zh: "已加密 —— 点锁解锁预览";
        readonly en: "Encrypted — tap lock to unlock preview";
        readonly ja: "暗号化済み — ロックをタップしてプレビュー";
        readonly tok: "ni li len. o luka e len la sina ken lukin.";
    };
    readonly "gal.delEmptyFolder": {
        readonly zh: "删除空文件夹";
        readonly en: "Delete empty folder";
        readonly ja: "空のフォルダを削除";
        readonly tok: "o weka e poki ni";
    };
    readonly "gal.delFolderNonEmpty": {
        readonly zh: "删除（请先清空里面）";
        readonly en: "Delete (empty it first)";
        readonly ja: "削除（先に中を空に）";
        readonly tok: "weka (o weka e ijo insa lon tenpo open)";
    };
    readonly "gal.divergedNote": {
        readonly zh: "云端副本已被别的设备移动或删除；本地这份有未推送的修改。";
        readonly en: "The cloud copy was moved or deleted by another device; this local copy has unpushed changes.";
        readonly ja: "クラウド側は別端末で移動/削除されました。ローカルには未送信の変更があります。";
        readonly tok: "ilo ante li tawa anu weka e sitelen ni lon poki sewi. sitelen pi ilo ni li jo e ante. ante ni li lon ala poki sewi.";
    };
    readonly "gal.renameKeep": {
        readonly zh: "重命名留存";
        readonly en: "Rename & keep";
        readonly ja: "名前を変えて保持";
        readonly tok: "o ante e nimi o awen";
    };
    readonly "gal.discardToTrash": {
        readonly zh: "丢弃（送回收站）";
        readonly en: "Discard (to trash)";
        readonly ja: "破棄（ゴミ箱へ）";
        readonly tok: "o weka tawa poki jaki";
    };
    readonly "gal.rename": {
        readonly zh: "重命名";
        readonly en: "Rename";
        readonly ja: "名前を変更";
        readonly tok: "ante nimi";
    };
    readonly "gal.moveTo": {
        readonly zh: "移动到…";
        readonly en: "Move to…";
        readonly ja: "移動…";
        readonly tok: "tawa poki ante…";
    };
    readonly "gal.copy": {
        readonly zh: "创建副本";
        readonly en: "Duplicate";
        readonly ja: "複製を作成";
        readonly tok: "o pali e sama";
    };
    readonly "gal.pullLocal": {
        readonly zh: "拉取到本地";
        readonly en: "Pull to local";
        readonly ja: "ローカルに取得";
        readonly tok: "o kama jo tawa ilo ni";
    };
    readonly "gal.pushCloud": {
        readonly zh: "推送到云端";
        readonly en: "Push to cloud";
        readonly ja: "クラウドに送信";
        readonly tok: "o pana tawa poki sewi";
    };
    readonly "gal.unloadLocal": {
        readonly zh: "卸载本地";
        readonly en: "Unload local";
        readonly ja: "ローカルを解放";
        readonly tok: "o weka e ona tan ilo ni (poki sewi li awen jo)";
    };
    readonly "gal.toTrash": {
        readonly zh: "送到回收站";
        readonly en: "Move to trash";
        readonly ja: "ゴミ箱へ";
        readonly tok: "tawa poki jaki";
    };
    readonly "gal.reupload": {
        readonly zh: "重新上传";
        readonly en: "Re-upload";
        readonly ja: "再アップロード";
        readonly tok: "o pana sin tawa poki sewi";
    };
    readonly "gal.busy.reupload": {
        readonly zh: "重新上传中…";
        readonly en: "Re-uploading…";
        readonly ja: "再アップロード中…";
        readonly tok: "mi pana sin tawa poki sewi…";
    };
    readonly "gal.st.reuploaded": {
        readonly zh: "已重新上传：{name}";
        readonly en: "Re-uploaded: {name}";
        readonly ja: "再アップロード完了：{name}";
        readonly tok: "pana sin li pini: {name}";
    };
    readonly "gal.st.reuploadConflict": {
        readonly zh: "云端已存在同名文件，未覆盖：{name}（请改名或从云端拉取）";
        readonly en: "A file with that name already exists on cloud; not overwritten: {name}";
        readonly ja: "クラウドに同名ファイルが既に存在します。上書きしません：{name}";
        readonly tok: "nimi sama li lon poki sewi la mi pana ala: {name}. o ante e nimi (anu: o kama jo tan poki sewi).";
    };
    readonly "gal.st.reuploadFail": {
        readonly zh: "重新上传失败：{e}";
        readonly en: "Re-upload failed: {e}";
        readonly ja: "再アップロード失敗：{e}";
        readonly tok: "pana sin li pakala: {e}";
    };
    readonly "gal.deleted": {
        readonly zh: "删除";
        readonly en: "deleted";
        readonly ja: "削除";
        readonly tok: "weka";
    };
    readonly "gal.restore": {
        readonly zh: "恢复";
        readonly en: "Restore";
        readonly ja: "復元";
        readonly tok: "o kama sin";
    };
    readonly "gal.purge": {
        readonly zh: "永久删除";
        readonly en: "Delete forever";
        readonly ja: "完全に削除";
        readonly tok: "o moli";
    };
    readonly "gal.empty.trash": {
        readonly zh: "回收站是空的。";
        readonly en: "Trash is empty.";
        readonly ja: "ゴミ箱は空です。";
        readonly tok: "poki jaki li jo e ala.";
    };
    readonly "gal.empty.folder": {
        readonly zh: "文件夹 \"{f}\" 是空的";
        readonly en: "Folder “{f}” is empty";
        readonly ja: "フォルダ「{f}」は空です";
        readonly tok: "poki \"{f}\" li jo e ala";
    };
    readonly "gal.empty.none": {
        readonly zh: "还没有保存的作品。点右上加号新建一个，或先在 PC 上画一笔。";
        readonly en: "No saved artwork yet. Tap + at top-right to create one, or draw on PC first.";
        readonly ja: "保存された作品がありません。右上の＋で新規作成、またはPCで描いてください。";
        readonly tok: "sitelen li lon ala. o luka e \"+\" lon poka sewi la sina pali e sitelen sin.";
    };
    readonly "gal.loc.local": {
        readonly zh: "本地";
        readonly en: "Local";
        readonly ja: "ローカル";
        readonly tok: "ilo ni";
    };
    readonly "gal.loc.cloud": {
        readonly zh: "云端";
        readonly en: "Cloud";
        readonly ja: "クラウド";
        readonly tok: "poki sewi";
    };
    readonly "gal.scope.local": {
        readonly zh: "本地";
        readonly en: "local";
        readonly ja: "ローカル";
        readonly tok: "ilo ni";
    };
    readonly "gal.scope.cloud": {
        readonly zh: "云端";
        readonly en: "cloud";
        readonly ja: "クラウド";
        readonly tok: "poki sewi";
    };
    readonly "gal.scope.both": {
        readonly zh: "本地和云端";
        readonly en: "local and cloud";
        readonly ja: "ローカルとクラウド";
        readonly tok: "ilo ni en poki sewi";
    };
    readonly "gal.root": {
        readonly zh: "根目录";
        readonly en: "root";
        readonly ja: "ルート";
        readonly tok: "poki lawa";
    };
    readonly "gal.rootFolder": {
        readonly zh: "/ 根目录";
        readonly en: "/ root";
        readonly ja: "/ ルート";
        readonly tok: "/ poki lawa";
    };
    readonly "gal.verb.encrypt": {
        readonly zh: "加密";
        readonly en: "encrypt";
        readonly ja: "暗号化";
        readonly tok: "len";
    };
    readonly "gal.verb.decrypt": {
        readonly zh: "解除加密";
        readonly en: "decrypt";
        readonly ja: "暗号化解除";
        readonly tok: "weka len";
    };
    readonly "gal.dlg.rename": {
        readonly zh: "重命名";
        readonly en: "Rename";
        readonly ja: "名前を変更";
        readonly tok: "ante nimi";
    };
    readonly "gal.dlg.renameNote": {
        readonly zh: "重命名（{note}）";
        readonly en: "Rename ({note})";
        readonly ja: "名前を変更（{note}）";
        readonly tok: "ante nimi ({note})";
    };
    readonly "gal.ph.newName": {
        readonly zh: "新名字";
        readonly en: "New name";
        readonly ja: "新しい名前";
        readonly tok: "nimi sin";
    };
    readonly "gal.note.empty": {
        readonly zh: "名字不能空";
        readonly en: "Name can’t be empty";
        readonly ja: "名前は空にできません";
        readonly tok: "nimi li wile lon";
    };
    readonly "gal.note.fail": {
        readonly zh: "失败：{e}";
        readonly en: "Failed: {e}";
        readonly ja: "失敗：{e}";
        readonly tok: "pakala: {e}";
    };
    readonly "gal.note.taken": {
        readonly zh: "{loc}已有同名，换一个";
        readonly en: "{loc} already has this name, pick another";
        readonly ja: "{loc}に同名あり、別名に";
        readonly tok: "nimi sama li lon {loc}. o ante.";
    };
    readonly "gal.dlg.moveTitle": {
        readonly zh: "移动「{base}」到…";
        readonly en: "Move “{base}” to…";
        readonly ja: "「{base}」を移動…";
        readonly tok: "o tawa e \"{base}\" tawa…";
    };
    readonly "gal.dlg.moveMsg": {
        readonly zh: "选择目标文件夹";
        readonly en: "Choose target folder";
        readonly ja: "移動先フォルダを選択";
        readonly tok: "o wile e poki";
    };
    readonly "gal.dlg.decryptTitle": {
        readonly zh: "解除「{base}」的加密？";
        readonly en: "Decrypt “{base}”?";
        readonly ja: "「{base}」の暗号化を解除？";
        readonly tok: "sina wile ala wile weka e len tan sitelen \"{base}\"?";
    };
    readonly "gal.dlg.decryptMsg": {
        readonly zh: "内容将以明文存放在本机与云端，任何能访问此设备或云账号的人都能查看。";
        readonly en: "Contents will be stored as plaintext locally and in the cloud; anyone with access to this device or cloud account can view them.";
        readonly ja: "内容はローカルとクラウドに平文で保存され、この端末やクラウドにアクセスできる人は誰でも閲覧できます。";
        readonly tok: "len li weka la sitelen li open tawa jan ale. ona li lon ilo ni li lon poki sewi. jan pi ken open li ken lukin e ona.";
    };
    readonly "gal.dlg.delTitle": {
        readonly zh: "删除 \"{name}\"？";
        readonly en: "Delete “{name}”?";
        readonly ja: "「{name}」を削除？";
        readonly tok: "sina wile ala wile weka e \"{name}\"?";
    };
    readonly "gal.dlg.purgeTitle": {
        readonly zh: "永久删除 \"{name}\"？";
        readonly en: "Delete “{name}” forever?";
        readonly ja: "「{name}」を完全に削除？";
        readonly tok: "sina wile ala wile moli e \"{name}\"?";
    };
    readonly "gal.dlg.purgeMsg": {
        readonly zh: "不可撤销。";
        readonly en: "Cannot be undone.";
        readonly ja: "元に戻せません。";
        readonly tok: "sina ken ala weka e pali ni.";
    };
    readonly "gal.dlg.emptyTrashTitle": {
        readonly zh: "清空{label}回收站？";
        readonly en: "Empty {label} trash?";
        readonly ja: "{label}のゴミ箱を空に？";
        readonly tok: "sina wile ala wile moli e ale lon poki jaki {label}?";
    };
    readonly "gal.dlg.emptyTrashMsg": {
        readonly zh: "{label}回收站会被彻底清空，不可撤销。";
        readonly en: "The {label} trash will be permanently emptied. Cannot be undone.";
        readonly ja: "{label}のゴミ箱を完全に空にします。元に戻せません。";
        readonly tok: "ale lon poki jaki {label} li moli. sina ken ala weka e pali ni.";
    };
    readonly "gal.del.dirtyDetail": {
        readonly zh: "本地有**未推送到云端的修改**，删除会丢这些改动。云端备份进回收站可恢复。";
        readonly en: "Local has **unpushed changes**; deleting loses them. The cloud backup goes to trash and can be restored.";
        readonly ja: "ローカルに**未送信の変更**があり、削除すると失われます。クラウドのバックアップはゴミ箱に入り復元可能です。";
        readonly tok: "ilo ni li jo e ante pi pana ala. sina weka la ante ni li moli. sitelen pi poki sewi li tawa poki jaki la sina ken kama sin e ona.";
    };
    readonly "gal.del.syncedDetail": {
        readonly zh: "本地副本会一起删，云端进回收站可恢复。";
        readonly en: "The local copy is deleted too; the cloud copy goes to trash and can be restored.";
        readonly ja: "ローカルも削除され、クラウドはゴミ箱に入り復元可能です。";
        readonly tok: "sitelen pi ilo ni li weka kin. sitelen pi poki sewi li tawa poki jaki. sina ken kama sin e ona.";
    };
    readonly "gal.del.cloudDetail": {
        readonly zh: "会进云端回收站，可恢复。";
        readonly en: "Goes to cloud trash; can be restored.";
        readonly ja: "クラウドのゴミ箱に入り、復元可能です。";
        readonly tok: "ona li tawa poki jaki pi poki sewi. sina ken kama sin e ona.";
    };
    readonly "gal.del.localDetail": {
        readonly zh: "会进本地回收站，可恢复。";
        readonly en: "Goes to local trash; can be restored.";
        readonly ja: "ローカルのゴミ箱に入り、復元可能です。";
        readonly tok: "ona li tawa poki jaki pi ilo ni. sina ken kama sin e ona.";
    };
    readonly "gal.del.activeSuffix": {
        readonly zh: " 当前画布会关闭。";
        readonly en: " The current canvas will close.";
        readonly ja: " 現在のキャンバスは閉じられます。";
        readonly tok: " supa sitelen ni li pini.";
    };
    readonly "gal.busy.rename": {
        readonly zh: "正在重命名 {name} → {to}…";
        readonly en: "Renaming {name} → {to}…";
        readonly ja: "名前変更中 {name} → {to}…";
        readonly tok: "mi ante e nimi: {name} → {to}…";
    };
    readonly "gal.busy.move": {
        readonly zh: "正在移动 {base} → {target}…";
        readonly en: "Moving {base} → {target}…";
        readonly ja: "移動中 {base} → {target}…";
        readonly tok: "mi tawa e ona: {base} → {target}…";
    };
    readonly "gal.busy.copy": {
        readonly zh: "正在创建副本 {base}…";
        readonly en: "Duplicating {base}…";
        readonly ja: "複製中 {base}…";
        readonly tok: "mi pali e sama tan \"{base}\"…";
    };
    readonly "gal.busy.del": {
        readonly zh: "正在删除 {name}…";
        readonly en: "Deleting {name}…";
        readonly ja: "削除中 {name}…";
        readonly tok: "mi weka e {name}…";
    };
    readonly "gal.busy.restore": {
        readonly zh: "正在恢复 {name}…";
        readonly en: "Restoring {name}…";
        readonly ja: "復元中 {name}…";
        readonly tok: "mi kama sin e {name}…";
    };
    readonly "gal.busy.purge": {
        readonly zh: "正在永久删除 {name}…";
        readonly en: "Deleting {name} forever…";
        readonly ja: "完全に削除中 {name}…";
        readonly tok: "mi moli e {name}…";
    };
    readonly "gal.busy.emptyTrash": {
        readonly zh: "正在清空{label}回收站…";
        readonly en: "Emptying {label} trash…";
        readonly ja: "{label}のゴミ箱を空に…";
        readonly tok: "mi moli e ale lon poki jaki {label}…";
    };
    readonly "gal.st.cancelled": {
        readonly zh: "已取消";
        readonly en: "Cancelled";
        readonly ja: "キャンセルしました";
        readonly tok: "pali li weka";
    };
    readonly "gal.st.cancelledPw": {
        readonly zh: "已取消（需要密码）";
        readonly en: "Cancelled (password required)";
        readonly ja: "キャンセル（パスワードが必要）";
        readonly tok: "pali li weka (nimi len li wile)";
    };
    readonly "gal.st.nameUnchanged": {
        readonly zh: "名字未变";
        readonly en: "Name unchanged";
        readonly ja: "名前は変わっていません";
        readonly tok: "nimi li ante ala";
    };
    readonly "gal.st.renamed": {
        readonly zh: "已重命名：{to}";
        readonly en: "Renamed: {to}";
        readonly ja: "名前変更：{to}";
        readonly tok: "nimi sin li lon: {to}";
    };
    readonly "gal.st.renamed2": {
        readonly zh: "已重命名：{from} → {to}";
        readonly en: "Renamed: {from} → {to}";
        readonly ja: "名前変更：{from} → {to}";
        readonly tok: "nimi li ante: {from} → {to}";
    };
    readonly "gal.st.noOtherFolder": {
        readonly zh: "没有别的文件夹可移（先新建一个）";
        readonly en: "No other folder to move to (create one first)";
        readonly ja: "移動先のフォルダがありません（先に作成）";
        readonly tok: "poki ante li lon ala. o pali e poki sin lon tenpo open.";
    };
    readonly "gal.st.alreadyInFolder": {
        readonly zh: "已在该文件夹";
        readonly en: "Already in that folder";
        readonly ja: "既にそのフォルダ内です";
        readonly tok: "ona li lon poki ni";
    };
    readonly "gal.st.nameTakenTarget": {
        readonly zh: "{loc}目标已有同名「{base}」";
        readonly en: "{loc} target already has “{base}”";
        readonly ja: "{loc}の移動先に同名「{base}」あり";
        readonly tok: "nimi sama \"{base}\" li lon poki {loc}";
    };
    readonly "gal.st.moved": {
        readonly zh: "已移动到：{target}";
        readonly en: "Moved to: {target}";
        readonly ja: "移動先：{target}";
        readonly tok: "tawa li pini: {target}";
    };
    readonly "gal.st.moveFail": {
        readonly zh: "移动失败：{e}";
        readonly en: "Move failed: {e}";
        readonly ja: "移動失敗：{e}";
        readonly tok: "tawa li pakala: {e}";
    };
    readonly "gal.st.copyNoBytes": {
        readonly zh: "找不到源作品的字节，复制失败";
        readonly en: "Source artwork bytes not found; duplicate failed";
        readonly ja: "元作品のデータが見つからず複製失敗";
        readonly tok: "ijo pi sitelen mama li weka. pali sama li pakala.";
    };
    readonly "gal.st.copied": {
        readonly zh: "已创建副本：{name}";
        readonly en: "Duplicated: {name}";
        readonly ja: "複製：{name}";
        readonly tok: "sama sin li lon: {name}";
    };
    readonly "gal.st.copyFail": {
        readonly zh: "创建副本失败：{e}";
        readonly en: "Duplicate failed: {e}";
        readonly ja: "複製失敗：{e}";
        readonly tok: "pali sama li pakala: {e}";
    };
    readonly "gal.st.openActive": {
        readonly zh: "这画正开着 —— 先退出到图库再{verb}";
        readonly en: "This artwork is open — exit to gallery first to {verb}";
        readonly ja: "この作品は開いています — 先にギャラリーに戻って{verb}";
        readonly tok: "sitelen ni li open. o tawa tomo sitelen lon tenpo open. sina ken {verb} lon tenpo kama.";
    };
    readonly "gal.st.cloudPullFirst": {
        readonly zh: "纯云端作品先拉取到本地再{verb}";
        readonly en: "Pull the cloud-only artwork to local first to {verb}";
        readonly ja: "クラウドのみの作品は先にローカルへ取得してから{verb}";
        readonly tok: "sitelen ni li lon poki sewi taso. o kama jo e ona tawa ilo ni lon tenpo open. sina ken {verb} lon tenpo kama.";
    };
    readonly "gal.st.encNeedOnline": {
        readonly zh: "已同步过云端的作品需在线操作（本地与云端要一起换）";
        readonly en: "Cloud-synced artwork needs to be online (local and cloud swap together)";
        readonly ja: "クラウド同期済みの作品はオンラインで操作（ローカルとクラウドを同時に）";
        readonly tok: "sitelen ni li lon poki sewi kin. ilo li wile ken toki tawa poki sewi. sitelen pi ilo ni en sitelen pi poki sewi li wile ante lon tenpo sama.";
    };
    readonly "gal.st.noLocalBytes": {
        readonly zh: "本地字节缺失";
        readonly en: "Local bytes missing";
        readonly ja: "ローカルデータがありません";
        readonly tok: "ijo pi sitelen ni li lon ala ilo ni";
    };
    readonly "gal.st.encConflict": {
        readonly zh: "云端有更新版本：{name} —— 本地已换、已标未推送；打开后按冲突流程处理";
        readonly en: "Newer version in cloud: {name} — local swapped and marked unpushed; resolve conflict after opening";
        readonly ja: "クラウドに新しい版：{name} — ローカルは変更・未送信済み。開いてから競合を解決";
        readonly tok: "poki sewi li jo e sitelen sin: {name}. mi ante e sitelen pi ilo ni. pana li wile lon tenpo kama. sina open e ona la nasin pi ante tu li open.";
    };
    readonly "gal.st.encDeferred": {
        readonly zh: "{okMsg}（本地完成；云端暂未跟上，已标未推送，回线后推送即同步）";
        readonly en: "{okMsg} (local done; cloud not yet, marked unpushed; push when back online)";
        readonly ja: "{okMsg}（ローカル完了；クラウド未追従、未送信。オンライン復帰後に送信で同期）";
        readonly tok: "{okMsg} (ilo ni li pini. poki sewi li kama ala lon tenpo ni. sina ken toki tawa poki sewi la o pana.)";
    };
    readonly "gal.st.alreadyEnc": {
        readonly zh: "已是加密作品";
        readonly en: "Already encrypted";
        readonly ja: "既に暗号化済みです";
        readonly tok: "sitelen ni li len";
    };
    readonly "gal.st.encryptedOk": {
        readonly zh: "已加密：{name}（7-Zip 输此密码可恢复；忘记密码内容永久找不回）";
        readonly en: "Encrypted: {name} (7-Zip with this password can recover; forgotten password = permanently lost)";
        readonly ja: "暗号化：{name}（このパスワードで7-Zip復元可；忘れると内容は永久に失われます）";
        readonly tok: "len li lon: {name}. ilo \"7-Zip\" en nimi len ni li ken open e ona. sina weka e nimi len la sitelen li moli. sina ken ala open e ona lon tenpo ale.";
    };
    readonly "gal.st.encFail": {
        readonly zh: "加密失败：{e}";
        readonly en: "Encryption failed: {e}";
        readonly ja: "暗号化失敗：{e}";
        readonly tok: "len li pakala: {e}";
    };
    readonly "gal.st.notEnc": {
        readonly zh: "这不是加密作品";
        readonly en: "This artwork isn’t encrypted";
        readonly ja: "これは暗号化作品ではありません";
        readonly tok: "sitelen ni li jo e len ala";
    };
    readonly "gal.st.decrypted": {
        readonly zh: "已解除加密：{name}";
        readonly en: "Decrypted: {name}";
        readonly ja: "暗号化解除：{name}";
        readonly tok: "len li weka: {name}";
    };
    readonly "gal.st.decryptFail": {
        readonly zh: "解除加密失败：{e}";
        readonly en: "Decryption failed: {e}";
        readonly ja: "暗号化解除失敗：{e}";
        readonly tok: "weka len li pakala: {e}";
    };
    readonly "gal.st.unlocked": {
        readonly zh: "已解锁加密作品（密码只在内存，关页即忘）";
        readonly en: "Unlocked (password kept in memory only, forgotten on close)";
        readonly ja: "ロック解除（パスワードはメモリのみ、閉じると破棄）";
        readonly tok: "sitelen len li open. nimi len li awen lon tenpo ni taso. sina pini e ilo la mi weka e ona.";
    };
    readonly "gal.st.deleted": {
        readonly zh: "已删除：{name}";
        readonly en: "Deleted: {name}";
        readonly ja: "削除：{name}";
        readonly tok: "weka li pini: {name}";
    };
    readonly "gal.st.delCancelled": {
        readonly zh: "已取消，没有删除「{name}」";
        readonly en: "Cancelled — \"{name}\" was not deleted";
        readonly ja: "キャンセルしました。「{name}」は削除していません";
        readonly tok: "pali li weka. mi weka ala e \"{name}\".";
    };
    readonly "gal.st.delNothing": {
        readonly zh: "「{name}」本地和云端都没有，无事可删";
        readonly en: "\"{name}\" exists neither locally nor in the cloud — nothing to delete";
        readonly ja: "「{name}」はローカルにもクラウドにも存在しません";
        readonly tok: "\"{name}\" li lon ala ilo ni li lon ala poki sewi. mi ken weka e ala.";
    };
    readonly "gal.st.delLocalOnly": {
        readonly zh: "「{name}」已从本地移入回收站，但云端那份还在（离线或来历不明，没敢删）";
        readonly en: "\"{name}\" was moved to the local recycle bin, but the cloud copy remains (offline or unknown lineage)";
        readonly ja: "「{name}」をローカルのごみ箱に移動しましたが、クラウド側は残っています（オフラインまたは由来不明）";
        readonly tok: "\"{name}\" li tawa poki jaki pi ilo ni. taso sitelen pi poki sewi li awen. mi sona pona ala e ona la mi weka ala e ona.";
    };
    readonly "gal.st.delFail": {
        readonly zh: "删除失败：{e}";
        readonly en: "Delete failed: {e}";
        readonly ja: "削除失敗：{e}";
        readonly tok: "weka li pakala: {e}";
    };
    readonly "gal.st.folderDeleted": {
        readonly zh: "已删除空文件夹：{name}";
        readonly en: "Deleted empty folder: {name}";
        readonly ja: "空のフォルダを削除：{name}";
        readonly tok: "poki li weka: {name}";
    };
    readonly "gal.st.folderDelFail": {
        readonly zh: "删除文件夹失败：{e}";
        readonly en: "Folder delete failed: {e}";
        readonly ja: "フォルダ削除失敗：{e}";
        readonly tok: "weka poki li pakala: {e}";
    };
    readonly "gal.st.restored": {
        readonly zh: "已恢复：{name}";
        readonly en: "Restored: {name}";
        readonly ja: "復元：{name}";
        readonly tok: "kama sin li pini: {name}";
    };
    readonly "gal.st.restoredRenamed": {
        readonly zh: "已恢复：{name}（原名 {orig} 已被占用）";
        readonly en: "Restored: {name} (original name {orig} was taken)";
        readonly ja: "復元：{name}（元の名前 {orig} は使用中）";
        readonly tok: "kama sin li pini: {name}. nimi open {orig} li lon la mi pana e nimi sin.";
    };
    readonly "gal.st.restoreFail": {
        readonly zh: "恢复失败：{e}";
        readonly en: "Restore failed: {e}";
        readonly ja: "復元失敗：{e}";
        readonly tok: "kama sin li pakala: {e}";
    };
    readonly "gal.st.purged": {
        readonly zh: "已永久删除：{name}";
        readonly en: "Permanently deleted: {name}";
        readonly ja: "完全に削除：{name}";
        readonly tok: "moli li pini: {name}";
    };
    readonly "gal.st.purgeFail": {
        readonly zh: "永久删除失败：{e}";
        readonly en: "Permanent delete failed: {e}";
        readonly ja: "完全削除失敗：{e}";
        readonly tok: "moli li pakala: {e}";
    };
    readonly "gal.st.emptyTrashCloudNeedLogin": {
        readonly zh: "清空云端回收站需先登录并联网";
        readonly en: "Emptying cloud trash requires sign-in and network";
        readonly ja: "クラウドのゴミ箱を空にするにはサインインと接続が必要です";
        readonly tok: "poki sewi li wile sona e sina. ilo li wile ken toki tawa poki sewi.";
    };
    readonly "gal.st.emptyTrashCloudFail": {
        readonly zh: "{n} 项云端没清（可能离线），回线再清";
        readonly en: "{n} cloud item(s) not cleared (maybe offline); retry when online";
        readonly ja: "{n} 件がクラウドで未削除（オフライン？）。オンライン復帰後に再試行";
        readonly tok: "ijo {n} pi poki sewi li moli ala (ken la toki li pakala). o pali sin lon tenpo kama.";
    };
    readonly "gal.st.emptyTrashPartial": {
        readonly zh: "清空时部分失败";
        readonly en: "Some items failed to clear";
        readonly ja: "一部の削除に失敗しました";
        readonly tok: "ijo lili li moli ala";
    };
    readonly "gal.st.emptyTrashDone": {
        readonly zh: "已清空{label}回收站";
        readonly en: "Emptied {label} trash";
        readonly ja: "{label}のゴミ箱を空にしました";
        readonly tok: "poki jaki {label} li jo e ala";
    };
    readonly "sc.cat.edit": {
        readonly zh: "编辑";
        readonly en: "Edit";
        readonly ja: "編集";
        readonly tok: "ante";
    };
    readonly "sc.cat.lasso": {
        readonly zh: "套索";
        readonly en: "Lasso";
        readonly ja: "投げ縄";
        readonly tok: "ma wile";
    };
    readonly "sc.cat.tools": {
        readonly zh: "工具";
        readonly en: "Tools";
        readonly ja: "ツール";
        readonly tok: "ilo";
    };
    readonly "sc.cat.panels": {
        readonly zh: "窗格";
        readonly en: "Panels";
        readonly ja: "パネル";
        readonly tok: "lupa";
    };
    readonly "sc.cat.view": {
        readonly zh: "视图";
        readonly en: "View";
        readonly ja: "表示";
        readonly tok: "lukin";
    };
    readonly "sc.cat.size": {
        readonly zh: "笔粗";
        readonly en: "Size";
        readonly ja: "太さ";
        readonly tok: "suli linja";
    };
    readonly "sc.cat.other": {
        readonly zh: "其它";
        readonly en: "Other";
        readonly ja: "その他";
        readonly tok: "ijo ante";
    };
    readonly "sc.undo": {
        readonly zh: "撤销";
        readonly en: "Undo";
        readonly ja: "元に戻す";
        readonly tok: "weka pi pali pini";
    };
    readonly "sc.redo": {
        readonly zh: "重做";
        readonly en: "Redo";
        readonly ja: "やり直す";
        readonly tok: "pali sin";
    };
    readonly "sc.copyClip": {
        readonly zh: "复制到剪贴板";
        readonly en: "Copy to clipboard";
        readonly ja: "クリップボードにコピー";
        readonly tok: "pana tawa poki kipisi";
    };
    readonly "sc.pasteLayer": {
        readonly zh: "粘贴为新层";
        readonly en: "Paste as new layer";
        readonly ja: "新規レイヤーとして貼り付け";
        readonly tok: "kama jo tawa lipu sin";
    };
    readonly "sc.applyTransform": {
        readonly zh: "应用变换";
        readonly en: "Apply transform";
        readonly ja: "変形を適用";
        readonly tok: "pini pi ante selo";
    };
    readonly "sc.cancelTransform": {
        readonly zh: "取消变换";
        readonly en: "Cancel transform";
        readonly ja: "変形をキャンセル";
        readonly tok: "weka pi ante selo";
    };
    readonly "sc.deselect": {
        readonly zh: "取消选区";
        readonly en: "Deselect";
        readonly ja: "選択を解除";
        readonly tok: "wile ala";
    };
    readonly "sc.selectAll": {
        readonly zh: "全选";
        readonly en: "Select all";
        readonly ja: "すべて選択";
        readonly tok: "wile ale";
    };
    readonly "sc.invert": {
        readonly zh: "反选";
        readonly en: "Invert selection";
        readonly ja: "選択を反転";
        readonly tok: "wile ante";
    };
    readonly "sc.transformSel": {
        readonly zh: "变换选区";
        readonly en: "Transform selection";
        readonly ja: "選択範囲を変形";
        readonly tok: "ante selo pi ma wile";
    };
    readonly "sc.transformSelPwa": {
        readonly zh: "变换选区（仅 PWA；浏览器标签页内 Ctrl+T 被占用）";
        readonly en: "Transform selection (PWA only; Ctrl+T is taken in a browser tab)";
        readonly ja: "選択範囲を変形（PWAのみ；ブラウザタブでは Ctrl+T が使用中）";
        readonly tok: "ante selo pi ma wile (PWA taso)";
    };
    readonly "sc.floatCopy": {
        readonly zh: "复制选区为浮层";
        readonly en: "Copy selection to float";
        readonly ja: "選択を浮遊レイヤーに複製";
        readonly tok: "pali sama tawa lipu sewi";
    };
    readonly "sc.brush": {
        readonly zh: "笔刷";
        readonly en: "Brush";
        readonly ja: "ブラシ";
        readonly tok: "ilo sitelen";
    };
    readonly "sc.eraser": {
        readonly zh: "橡皮";
        readonly en: "Eraser";
        readonly ja: "消しゴム";
        readonly tok: "ilo weka";
    };
    readonly "sc.picker": {
        readonly zh: "吸色";
        readonly en: "Eyedropper";
        readonly ja: "スポイト";
        readonly tok: "ilo pi kama kule";
    };
    readonly "sc.lasso": {
        readonly zh: "套索";
        readonly en: "Lasso";
        readonly ja: "投げ縄";
        readonly tok: "ilo pi ma wile";
    };
    readonly "sc.fillMode": {
        readonly zh: "油漆桶（填充工具）";
        readonly en: "Paint bucket (fill tool)";
        readonly ja: "塗りつぶしツール";
        readonly tok: "ilo pi kule ma";
    };
    readonly "sc.pan": {
        readonly zh: "平移";
        readonly en: "Pan";
        readonly ja: "手のひら";
        readonly tok: "ilo tawa";
    };
    readonly "sc.colorPanel": {
        readonly zh: "颜色窗格";
        readonly en: "Color panel";
        readonly ja: "カラーパネル";
        readonly tok: "lupa kule";
    };
    readonly "sc.layerPanel": {
        readonly zh: "图层窗格";
        readonly en: "Layers panel";
        readonly ja: "レイヤーパネル";
        readonly tok: "lupa lipu";
    };
    readonly "sc.centerCanvas": {
        readonly zh: "画布居中";
        readonly en: "Center canvas";
        readonly ja: "キャンバスを中央に";
        readonly tok: "supa lon insa";
    };
    readonly "sc.zoomIn": {
        readonly zh: "放大";
        readonly en: "Zoom in";
        readonly ja: "拡大";
        readonly tok: "lukin suli";
    };
    readonly "sc.zoomOut": {
        readonly zh: "缩小";
        readonly en: "Zoom out";
        readonly ja: "縮小";
        readonly tok: "lukin lili";
    };
    readonly "sc.sizeDown": {
        readonly zh: "笔粗 -";
        readonly en: "Size −";
        readonly ja: "太さ −";
        readonly tok: "suli linja −";
    };
    readonly "sc.sizeUp": {
        readonly zh: "笔粗 +";
        readonly en: "Size +";
        readonly ja: "太さ +";
        readonly tok: "suli linja +";
    };
    readonly "gal.chrome.add": {
        readonly zh: "新增";
        readonly en: "Add";
        readonly ja: "追加";
        readonly tok: "sin";
    };
    readonly "gal.chrome.menuTip": {
        readonly zh: "图库菜单（更新 / 设置）";
        readonly en: "Gallery menu (updates / settings)";
        readonly ja: "ギャラリーメニュー（更新 / 設定）";
        readonly tok: "nasin pi tomo sitelen";
    };
    readonly "gal.chrome.back": {
        readonly zh: "返回图库";
        readonly en: "Back to gallery";
        readonly ja: "ギャラリーに戻る";
        readonly tok: "tawa tomo sitelen";
    };
    readonly "gal.chrome.trashOps": {
        readonly zh: "回收站操作";
        readonly en: "Trash actions";
        readonly ja: "ゴミ箱の操作";
        readonly tok: "nasin pi poki jaki";
    };
    readonly "gal.chrome.emptyLocal": {
        readonly zh: "清空本地回收站";
        readonly en: "Empty local trash";
        readonly ja: "ローカルのゴミ箱を空に";
        readonly tok: "o moli e insa pi poki jaki (ilo ni)";
    };
    readonly "gal.chrome.emptyCloud": {
        readonly zh: "清空云端回收站";
        readonly en: "Empty cloud trash";
        readonly ja: "クラウドのゴミ箱を空に";
        readonly tok: "o moli e insa pi poki jaki (poki sewi)";
    };
    readonly "gal.chrome.versionTip": {
        readonly zh: "当前 WebPaint 版本";
        readonly en: "Current WebPaint version";
        readonly ja: "現在の WebPaint バージョン";
        readonly tok: "nanpa mi pi tenpo ni";
    };
    readonly "gal.menu.theme": {
        readonly zh: "主题…";
        readonly en: "Theme…";
        readonly ja: "テーマ…";
        readonly tok: "nasin kule…";
    };
    readonly "gal.menu.unlock": {
        readonly zh: "解锁加密作品…";
        readonly en: "Unlock encrypted artwork…";
        readonly ja: "暗号化作品のロック解除…";
        readonly tok: "o open e sitelen len…";
    };
    readonly "gal.menu.newDoc": {
        readonly zh: "新建作品…";
        readonly en: "New artwork…";
        readonly ja: "新規作品…";
        readonly tok: "sitelen sin…";
    };
    readonly "gal.menu.newFromImage": {
        readonly zh: "从图片新建…";
        readonly en: "New from image…";
        readonly ja: "画像から新規…";
        readonly tok: "sitelen sin tan sitelen ante…";
    };
    readonly "gal.menu.newFromClipboard": {
        readonly zh: "从剪切板新建";
        readonly en: "New from clipboard";
        readonly ja: "クリップボードから新規";
        readonly tok: "sitelen sin tan poki kipisi";
    };
    readonly "gal.menu.newFolder": {
        readonly zh: "新建文件夹…";
        readonly en: "New folder…";
        readonly ja: "新規フォルダ…";
        readonly tok: "poki sin…";
    };
    readonly "gal.menu.signIn": {
        readonly zh: "登录 OneDrive";
        readonly en: "Sign in to OneDrive";
        readonly ja: "OneDrive にサインイン";
        readonly tok: "poki sewi \"OneDrive\" o sona e mi";
    };
    readonly "gal.menu.signOut": {
        readonly zh: "退出登录";
        readonly en: "Sign out";
        readonly ja: "サインアウト";
        readonly tok: "poki sewi o weka e sona mi";
    };
    readonly "nd.title": {
        readonly zh: "新建作品";
        readonly en: "New artwork";
        readonly ja: "新規作品";
        readonly tok: "sitelen sin";
    };
    readonly "nd.untitled": {
        readonly zh: "未命名";
        readonly en: "Untitled";
        readonly ja: "無題";
        readonly tok: "nimi ala";
    };
    readonly "nd.custom": {
        readonly zh: "自定义…";
        readonly en: "Custom…";
        readonly ja: "カスタム…";
        readonly tok: "nasin sina…";
    };
    readonly "nd.size": {
        readonly zh: "尺寸";
        readonly en: "Size";
        readonly ja: "サイズ";
        readonly tok: "suli";
    };
    readonly "nd.create": {
        readonly zh: "创建";
        readonly en: "Create";
        readonly ja: "作成";
        readonly tok: "o pali";
    };
    readonly "fp.reference": {
        readonly zh: "参考";
        readonly en: "Reference";
        readonly ja: "参考";
        readonly tok: "sitelen lukin";
    };
    readonly "lp.foot.add": {
        readonly zh: "新建 / 导入";
        readonly en: "New / import";
        readonly ja: "新規 / インポート";
        readonly tok: "sin / kama jo";
    };
    readonly "lp.foot.up": {
        readonly zh: "上移图层";
        readonly en: "Move layer up";
        readonly ja: "レイヤーを上へ";
        readonly tok: "o tawa sewi e lipu";
    };
    readonly "lp.foot.down": {
        readonly zh: "下移图层";
        readonly en: "Move layer down";
        readonly ja: "レイヤーを下へ";
        readonly tok: "o tawa anpa e lipu";
    };
    readonly "lp.foot.del": {
        readonly zh: "删除当前图层";
        readonly en: "Delete current layer";
        readonly ja: "現在のレイヤーを削除";
        readonly tok: "o weka e lipu ni";
    };
    readonly "lp.foot.newGroup": {
        readonly zh: "新建图层组";
        readonly en: "New group";
        readonly ja: "新規グループ";
        readonly tok: "kulupu sin";
    };
    readonly "lp.foot.importPhoto": {
        readonly zh: "导入文件";
        readonly en: "Import file";
        readonly ja: "ファイルを読み込む";
        readonly tok: "o kama jo e sitelen";
    };
    readonly "lp.foot.importClipboard": {
        readonly zh: "导入剪贴板";
        readonly en: "Import from clipboard";
        readonly ja: "クリップボードから読み込む";
        readonly tok: "o kama jo tan poki kipisi";
    };
    readonly "lp.foot.stampAll": {
        readonly zh: "合并全部为新层";
        readonly en: "Collapse all into new layer";
        readonly ja: "すべてを結合して新規レイヤーへ";
        readonly tok: "o wan e lipu ale tawa lipu sin";
    };
    readonly "ref.load": {
        readonly zh: "从文件载入";
        readonly en: "Load from file";
        readonly ja: "ファイルから読み込む";
        readonly tok: "o kama jo e sitelen";
    };
    readonly "ref.live": {
        readonly zh: "实时镜像主画布";
        readonly en: "Live mirror of canvas";
        readonly ja: "キャンバスをライブミラー";
        readonly tok: "sama supa sitelen lon tenpo ale";
    };
    readonly "ref.fit": {
        readonly zh: "适应窗口";
        readonly en: "Fit to window";
        readonly ja: "ウィンドウに合わせる";
        readonly tok: "suli sama lupa";
    };
    readonly "ref.resizeAria": {
        readonly zh: "拖动调整窗口大小";
        readonly en: "Drag to resize window";
        readonly ja: "ドラッグでウィンドウサイズ変更";
        readonly tok: "luka la suli li ante";
    };
    readonly "ref.resize": {
        readonly zh: "拖动调整大小";
        readonly en: "Drag to resize";
        readonly ja: "ドラッグでサイズ変更";
        readonly tok: "luka la suli li ante";
    };
    readonly "ref.picking": {
        readonly zh: "吸色（参考）";
        readonly en: "Picking color (reference)";
        readonly ja: "スポイト（参考）";
        readonly tok: "kama jo e kule (sitelen lukin)";
    };
    readonly "ref.pick": {
        readonly zh: "选个图当参考";
        readonly en: "Pick an image as reference";
        readonly ja: "参考用の画像を選択";
        readonly tok: "o wile e sitelen lukin";
    };
    readonly "ref.hintFolder": {
        readonly zh: "文件夹图标 = 加载图片";
        readonly en: "Folder icon = load image";
        readonly ja: "フォルダアイコン = 画像を読み込む";
        readonly tok: "sitelen poki: o kama jo e sitelen";
    };
    readonly "ref.hintPip": {
        readonly zh: "画中画图标 = 实时镜像主画布";
        readonly en: "PiP icon = live mirror of canvas";
        readonly ja: "PiPアイコン = キャンバスをライブミラー";
        readonly tok: "sitelen lupa: sama supa sitelen lon tenpo ale";
    };
    readonly "ref.hintGesture": {
        readonly zh: "单指拖移 / 双指 pinch + 旋转 / 双击适应";
        readonly en: "One-finger drag / two-finger pinch + rotate / double-tap to fit";
        readonly ja: "一本指ドラッグ / 二本指ピンチ+回転 / ダブルタップでフィット";
        readonly tok: "luka wan: tawa · luka tu: suli / sike · luka pi tenpo tu: suli pona";
    };
    readonly "la.stack": {
        readonly zh: "套索 / 选区";
        readonly en: "Lasso / selection";
        readonly ja: "投げ縄 / 選択";
        readonly tok: "ilo pi ma wile";
    };
    readonly "la.freehand": {
        readonly zh: "自由套索";
        readonly en: "Freehand lasso";
        readonly ja: "フリーハンド投げ縄";
        readonly tok: "nasin luka";
    };
    readonly "la.rect": {
        readonly zh: "矩形选区";
        readonly en: "Rectangle";
        readonly ja: "長方形選択";
        readonly tok: "leko";
    };
    readonly "la.ellipse": {
        readonly zh: "椭圆选区";
        readonly en: "Ellipse";
        readonly ja: "楕円選択";
        readonly tok: "sike";
    };
    readonly "la.magic": {
        readonly zh: "魔术棒";
        readonly en: "Magic wand";
        readonly ja: "自動選択";
        readonly tok: "ilo pi ma sama";
    };
    readonly "la.algoSel": {
        readonly zh: "魔棒算法";
        readonly en: "Wand algorithm";
        readonly ja: "選択アルゴリズム";
        readonly tok: "nasin pi ilo wile";
    };
    readonly "la.algoCfg": {
        readonly zh: "算法设置";
        readonly en: "Algorithm settings";
        readonly ja: "アルゴリズム設定";
        readonly tok: "ken nasin";
    };
    readonly "la.closeDist": {
        readonly zh: "闭合距离";
        readonly en: "Gap closing distance";
        readonly ja: "隙間閉じ距離";
        readonly tok: "suli pi pini linja";
    };
    readonly "la.inkThreshold": {
        readonly zh: "墨线判定";
        readonly en: "Ink threshold";
        readonly ja: "線判定しきい値";
        readonly tok: "suli pi linja pimeja";
    };
    readonly "la.minRegion": {
        readonly zh: "碎区下限";
        readonly en: "Min region size";
        readonly ja: "最小領域";
        readonly tok: "suli anpa pi ma lili";
    };
    readonly "la.tipSens": {
        readonly zh: "端点灵敏度";
        readonly en: "Tip sensitivity";
        readonly ja: "端点感度";
        readonly tok: "ken pi pini linja";
    };
    readonly "la.lineartDebug": {
        readonly zh: "调试视图";
        readonly en: "Debug view";
        readonly ja: "デバッグ表示";
        readonly tok: "lukin sona";
    };
    readonly "la.underLine": {
        readonly zh: "填到线下";
        readonly en: "Under-line bleed";
        readonly ja: "線下への塗り込み";
        readonly tok: "kule anpa linja";
    };
    readonly "la.bleedAuto": {
        readonly zh: "自动";
        readonly en: "Auto";
        readonly ja: "自動";
        readonly tok: "nasin ilo";
    };
    readonly "la.algoClassic": {
        readonly zh: "像素精确";
        readonly en: "Pixel-perfect flood";
        readonly ja: "ピクセル精確";
        readonly tok: "nasin pi kule sama";
    };
    readonly "la.lineartAlgo": {
        readonly zh: "线稿闭合";
        readonly en: "Line-art closing";
        readonly ja: "線画クロージング";
        readonly tok: "nasin pi linja pini";
    };
    readonly "la.algoSimilar": {
        readonly zh: "全图同色";
        readonly en: "Similar color (global)";
        readonly ja: "全域同色";
        readonly tok: "nasin pi kule sama lon ale";
    };
    readonly "la.metric": {
        readonly zh: "色差";
        readonly en: "Color distance";
        readonly ja: "色差";
        readonly tok: "nasin pi ante kule";
    };
    readonly "la.fillGap": {
        readonly zh: "容隙";
        readonly en: "Close gaps";
        readonly ja: "隙間とじ";
        readonly tok: "pini lupa";
    };
    readonly "la.penSub": {
        readonly zh: "选区笔";
        readonly en: "Selection pen";
        readonly ja: "選択ペン";
        readonly tok: "ilo sitelen pi ma pini";
    };
    readonly "la.new": {
        readonly zh: "新建选区（替换当前）";
        readonly en: "New selection (replace)";
        readonly ja: "新規選択（置き換え）";
        readonly tok: "sin (ma pini li weka)";
    };
    readonly "la.union": {
        readonly zh: "添加到选区";
        readonly en: "Add to selection";
        readonly ja: "選択範囲に追加";
        readonly tok: "namako";
    };
    readonly "la.subtract": {
        readonly zh: "从选区减去";
        readonly en: "Subtract from selection";
        readonly ja: "選択範囲から削除";
        readonly tok: "weka";
    };
    readonly "la.selectAll": {
        readonly zh: "全选 (Ctrl+A)";
        readonly en: "Select all (Ctrl+A)";
        readonly ja: "すべて選択 (Ctrl+A)";
        readonly tok: "o wile e ale (Ctrl+A)";
    };
    readonly "la.invert": {
        readonly zh: "反选 (Ctrl+Shift+I)";
        readonly en: "Invert (Ctrl+Shift+I)";
        readonly ja: "選択を反転 (Ctrl+Shift+I)";
        readonly tok: "o wile e ante (Ctrl+Shift+I)";
    };
    readonly "la.selEdit": {
        readonly zh: "编辑选区：扩张 / 收缩";
        readonly en: "Edit selection: expand / shrink";
        readonly ja: "選択範囲を編集：拡張 / 縮小";
        readonly tok: "ante pi ma wile: suli / lili";
    };
    readonly "la.deselect": {
        readonly zh: "取消选区 (Ctrl+D)";
        readonly en: "Deselect (Ctrl+D)";
        readonly ja: "選択を解除 (Ctrl+D)";
        readonly tok: "o wile e ala (Ctrl+D)";
    };
    readonly "la.constrain": {
        readonly zh: "约束 1:1（正方 / 圆）";
        readonly en: "Constrain 1:1 (square / circle)";
        readonly ja: "1:1に固定（正方形 / 円）";
        readonly tok: "sama poka (leko / sike)";
    };
    readonly "la.sampleMode": {
        readonly zh: "采样模式";
        readonly en: "Sample mode";
        readonly ja: "サンプリングモード";
        readonly tok: "nasin lukin";
    };
    readonly "la.threshold": {
        readonly zh: "阈值";
        readonly en: "Threshold";
        readonly ja: "しきい値";
        readonly tok: "suli ante";
    };
    readonly "la.subSlot": {
        readonly zh: "选区方式（自由 / 矩形 / 椭圆 / 魔棒）";
        readonly en: "Selection mode (freehand / rect / ellipse / wand)";
        readonly ja: "選択方式（フリー / 矩形 / 楕円 / 自動）";
        readonly tok: "nasin pi ma wile";
    };
    readonly "la.setOpSlot": {
        readonly zh: "布尔模式（新建 / 添加 / 减去）";
        readonly en: "Boolean mode";
        readonly ja: "ブールモード";
        readonly tok: "nasin (sin / namako / weka)";
    };
    readonly "sb.stack": {
        readonly zh: "形状笔工具栏";
        readonly en: "Shape brush toolbar";
        readonly ja: "図形ブラシツールバー";
        readonly tok: "poki pi ilo selo";
    };
    readonly "sb.subSlot": {
        readonly zh: "形状（直线 / 矩形 / 圆·弧）";
        readonly en: "Shape (line / rect / circle·arc)";
        readonly ja: "図形（直線 / 矩形 / 円·弧）";
        readonly tok: "selo (linja / leko / sike)";
    };
    readonly "sb.line": {
        readonly zh: "直线";
        readonly en: "Line";
        readonly ja: "直線";
        readonly tok: "linja";
    };
    readonly "sb.rect": {
        readonly zh: "矩形（相对屏幕拉框，斜的转视口画）";
        readonly en: "Rectangle (screen-aligned; rotate view for tilted)";
        readonly ja: "矩形（画面基準、斜めはビュー回転で）";
        readonly tok: "leko";
    };
    readonly "sb.circle": {
        readonly zh: "圆 / 弧（徒手画一圈自动拟合，不满一圈出弧）";
        readonly en: "Circle / arc (freehand, auto-fit; partial sweep = arc)";
        readonly ja: "円 / 弧（手描きフィット、一周未満は弧）";
        readonly tok: "sike (open la sike pini ala li ken)";
    };
    readonly "sb.constrain": {
        readonly zh: "约束（直线 15° 吸附 / 正方 / 正圆；透视下吸向消失点·平面正形。按住 Shift 临时反转）";
        readonly en: "Constrain (15° snap / square / circle; toward VP in perspective. Hold Shift to invert)";
        readonly ja: "拘束（15°スナップ / 正方形 / 正円。Shift 長押しで一時反転）";
        readonly tok: "sama poka (15° / leko sama / sike sama; luka Shift la ante)";
    };
    readonly "sb.grid": {
        readonly zh: "格线（头身比 / 构图格；默认 2×6）";
        readonly en: "Grid (proportions; default 2×6)";
        readonly ja: "グリッド（頭身 / 構図、既定 2×6）";
        readonly tok: "linja mute (2×6)";
    };
    readonly "sb.varLineFree": {
        readonly zh: "自由线条";
        readonly en: "Free line";
        readonly ja: "自由な直線";
        readonly tok: "linja nasa";
    };
    readonly "sb.varLineSnap": {
        readonly zh: "吸附线条（15°/透视）";
        readonly en: "Snapped line (15° / perspective)";
        readonly ja: "スナップ直線";
        readonly tok: "linja pi nasin pona";
    };
    readonly "sb.varRect": {
        readonly zh: "长方形";
        readonly en: "Rectangle";
        readonly ja: "長方形";
        readonly tok: "leko suli";
    };
    readonly "sb.varSquare": {
        readonly zh: "正方形";
        readonly en: "Square";
        readonly ja: "正方形";
        readonly tok: "leko sama";
    };
    readonly "sb.varEllipse": {
        readonly zh: "椭圆";
        readonly en: "Ellipse";
        readonly ja: "楕円";
        readonly tok: "sike suli";
    };
    readonly "sb.varCircle": {
        readonly zh: "正圆";
        readonly en: "Circle";
        readonly ja: "正円";
        readonly tok: "sike sama";
    };
    readonly "sb.border": {
        readonly zh: "外框（默认关）";
        readonly en: "Outer border (default off)";
        readonly ja: "外枠（既定オフ）";
        readonly tok: "selo sinpin";
    };
    readonly "sb.rows": {
        readonly zh: "行";
        readonly en: "Rows";
        readonly ja: "行";
        readonly tok: "linja";
    };
    readonly "sb.cols": {
        readonly zh: "列";
        readonly en: "Cols";
        readonly ja: "列";
        readonly tok: "palisa";
    };
    readonly "sb.gridMore": {
        readonly zh: "格线配置（行 / 列 / 外框）";
        readonly en: "Grid settings (rows / cols / border)";
        readonly ja: "グリッド設定";
        readonly tok: "nasin pi linja mute";
    };
    readonly "sb.perspModeSlot": {
        readonly zh: "透视模式（视口对齐 / 一点 / 二点 / 三点）";
        readonly en: "Perspective mode";
        readonly ja: "パースモード";
        readonly tok: "nasin lukin weka";
    };
    readonly "sb.planeSlot": {
        readonly zh: "作业平面（地板 / 墙）";
        readonly en: "Working plane";
        readonly ja: "作業平面";
        readonly tok: "ma pali";
    };
    readonly "sb.showGizmo": {
        readonly zh: "作画时显示消失点与地平线";
        readonly en: "Show VPs & horizon while drawing";
        readonly ja: "描画中もVP/地平線を表示";
        readonly tok: "lukin e sike weka lon tenpo sitelen";
    };
    readonly "sb.modeViewport": {
        readonly zh: "视口对齐（关透视）";
        readonly en: "Viewport-aligned (perspective off)";
        readonly ja: "ビュー整列（パースオフ）";
        readonly tok: "nasin lukin ala";
    };
    readonly "sb.mode1p": {
        readonly zh: "一点透视";
        readonly en: "1-point perspective";
        readonly ja: "一点透視";
        readonly tok: "sike weka wan";
    };
    readonly "sb.mode2p": {
        readonly zh: "二点透视";
        readonly en: "2-point perspective";
        readonly ja: "二点透視";
        readonly tok: "sike weka tu";
    };
    readonly "sb.mode3p": {
        readonly zh: "三点透视";
        readonly en: "3-point perspective";
        readonly ja: "三点透視";
        readonly tok: "sike weka tu wan";
    };
    readonly "sb.modeIso": {
        readonly zh: "等轴测（2:1 像素惯例）";
        readonly en: "Isometric (2:1 pixel convention)";
        readonly ja: "アイソメトリック（2:1）";
        readonly tok: "nasin sitelen leko";
    };
    readonly "sb.planeGround": {
        readonly zh: "地板";
        readonly en: "Ground";
        readonly ja: "床";
        readonly tok: "ma anpa";
    };
    readonly "sb.planeWall": {
        readonly zh: "墙";
        readonly en: "Wall";
        readonly ja: "壁";
        readonly tok: "sinpin";
    };
    readonly "sb.planeWallL": {
        readonly zh: "左墙";
        readonly en: "Left wall";
        readonly ja: "左壁";
        readonly tok: "sinpin pi poka soto";
    };
    readonly "sb.planeWallR": {
        readonly zh: "右墙";
        readonly en: "Right wall";
        readonly ja: "右壁";
        readonly tok: "sinpin pi poka pona";
    };
    readonly "sb.vpEdit": {
        readonly zh: "编辑消失点…";
        readonly en: "Edit vanishing points…";
        readonly ja: "消失点を編集…";
        readonly tok: "ante e sike weka…";
    };
    readonly "pe.hint": {
        readonly zh: "消失点：拖点定位（可拖到画布外）";
        readonly en: "Vanishing points: drag to place (off-canvas OK)";
        readonly ja: "消失点：ドラッグで配置";
        readonly tok: "sike weka: tawa e ona";
    };
    readonly "pe.reset": {
        readonly zh: "重置默认";
        readonly en: "Reset defaults";
        readonly ja: "既定に戻す";
        readonly tok: "open sin";
    };
    readonly "pe.ref": {
        readonly zh: "参考点";
        readonly en: "Reference point";
        readonly ja: "参照点";
        readonly tok: "sike lukin";
    };
    readonly "pe.lock": {
        readonly zh: "锁地平线";
        readonly en: "Lock horizon";
        readonly ja: "地平線ロック";
        readonly tok: "awen e linja ma";
    };
    readonly "la.resizeShort": {
        readonly zh: "扩张 / 收缩…";
        readonly en: "Expand / shrink…";
        readonly ja: "拡張 / 縮小…";
        readonly tok: "suli / lili…";
    };
    readonly "la.more": {
        readonly zh: "更多选区操作";
        readonly en: "More selection actions";
        readonly ja: "その他の選択操作";
        readonly tok: "ijo ante pi ma wile";
    };
    readonly "la.expandShort": {
        readonly zh: "扩张";
        readonly en: "Expand";
        readonly ja: "拡張";
        readonly tok: "suli";
    };
    readonly "la.selectAllShort": {
        readonly zh: "全选";
        readonly en: "Select all";
        readonly ja: "すべて選択";
        readonly tok: "wile ale";
    };
    readonly "la.invertShort": {
        readonly zh: "反选";
        readonly en: "Invert selection";
        readonly ja: "選択を反転";
        readonly tok: "wile ante";
    };
    readonly "la.clearPixels": {
        readonly zh: "清除选区内像素";
        readonly en: "Clear pixels in selection";
        readonly ja: "選択範囲のピクセルを消去";
        readonly tok: "o weka e kule lon ma wile";
    };
    readonly "fm.noTransform": {
        readonly zh: "填色模式没有变换——先回套索";
        readonly en: "No transform in fill mode — switch to lasso first";
        readonly ja: "塗りつぶしモードでは変形できません";
        readonly tok: "ilo pi kule ma la sina ken ala ante e ma";
    };
    readonly "sc.shapeBrush": {
        readonly zh: "形状笔";
        readonly en: "Shape brush";
        readonly ja: "シェイプブラシ";
        readonly tok: "ilo pi sitelen selo";
    };
    readonly "la.antsToggle": {
        readonly zh: "蚂蚁线";
        readonly en: "Marching ants";
        readonly ja: "選択範囲の点線";
        readonly tok: "linja pi ma wile";
    };
    readonly "la.fromLayerShort": {
        readonly zh: "从图层建选区";
        readonly en: "Selection from layer";
        readonly ja: "レイヤーから選択範囲";
        readonly tok: "o pali e ma wile tan lipu ni";
    };
    readonly "la.fromLayerEmpty": {
        readonly zh: "当前图层是空的，没有可选像素";
        readonly en: "Active layer is empty — nothing to select";
        readonly ja: "現在のレイヤーは空です。選択できるピクセルがありません";
        readonly tok: "lipu ni li jo e ala. ma wile li ken ala";
    };
    readonly "la.toFillShort": {
        readonly zh: "送入填色";
        readonly en: "Send to fill";
        readonly ja: "塗りつぶしへ送る";
        readonly tok: "o pana e ma wile tawa ilo pi kule ma";
    };
    readonly "la.polygon": {
        readonly zh: "多边形套索（逐点落顶点，点回起点闭合）";
        readonly en: "Polygon lasso (tap to add vertices, tap start to close)";
        readonly ja: "多角形選択（頂点をタップで追加、始点で閉じる）";
        readonly tok: "ma wile pi linja mute";
    };
    readonly "sc.polygonCancel": {
        readonly zh: "取消多边形";
        readonly en: "Cancel polygon";
        readonly ja: "多角形をキャンセル";
        readonly tok: "o pini ala e linja mute";
    };
    readonly "sc.polygonClose": {
        readonly zh: "闭合多边形";
        readonly en: "Close polygon";
        readonly ja: "多角形を閉じる";
        readonly tok: "o pini e linja mute";
    };
    readonly "la.duplicate": {
        readonly zh: "复制选区到新层";
        readonly en: "Duplicate selection to new layer";
        readonly ja: "選択範囲を新規レイヤーに複製";
        readonly tok: "o pali e sama pi ma wile lon lipu sin";
    };
    readonly "la.moveToLayer": {
        readonly zh: "选区移动到新层";
        readonly en: "Move selection to new layer";
        readonly ja: "選択範囲を新規レイヤーへ移動";
        readonly tok: "o tawa e ma wile tawa lipu sin";
    };
    readonly "la.editSel": {
        readonly zh: "编辑选区";
        readonly en: "Edit selection";
        readonly ja: "選択範囲を編集";
        readonly tok: "ante pi ma wile";
    };
    readonly "la.expand": {
        readonly zh: "扩张…";
        readonly en: "Expand…";
        readonly ja: "拡張…";
        readonly tok: "suli…";
    };
    readonly "la.shrink": {
        readonly zh: "收缩…";
        readonly en: "Shrink…";
        readonly ja: "縮小…";
        readonly tok: "lili…";
    };
    readonly "la.expandShrink": {
        readonly zh: "扩张 / 收缩选区";
        readonly en: "Expand / shrink selection";
        readonly ja: "選択範囲の拡張 / 縮小";
        readonly tok: "ante suli pi ma wile";
    };
    readonly "la.pixelCount": {
        readonly zh: "像素数";
        readonly en: "Pixels";
        readonly ja: "ピクセル数";
        readonly tok: "nanpa leko";
    };
    readonly "pick.toolbar": {
        readonly zh: "吸色取样";
        readonly en: "Eyedropper sampling";
        readonly ja: "スポイトのサンプリング";
        readonly tok: "kama kule";
    };
    readonly "la.autoExpand": {
        readonly zh: "自动扩张";
        readonly en: "Auto expand";
        readonly ja: "自動拡張";
        readonly tok: "ilo li suli e ona";
    };
    readonly "la.flipH": {
        readonly zh: "水平翻转";
        readonly en: "Flip horizontal";
        readonly ja: "左右反転";
        readonly tok: "o jasima e poka";
    };
    readonly "mi.dropChoiceTitle": {
        readonly zh: "拖入的图片怎么用？";
        readonly en: "How to use the dropped image?";
        readonly ja: "ドロップした画像をどう使いますか？";
        readonly tok: "mi pali e seme kepeken sitelen ni?";
    };
    readonly "save.saving": {
        readonly zh: "「{name}」保存中…";
        readonly en: "Saving “{name}”…";
        readonly ja: "「{name}」を保存中…";
        readonly tok: "mi awen e “{name}”…";
    };
    readonly "mi.dropAsLayer": {
        readonly zh: "插入为新图层";
        readonly en: "Insert as new layer";
        readonly ja: "新しいレイヤーとして挿入";
        readonly tok: "o pana lon lipu sin";
    };
    readonly "mi.dropAsReference": {
        readonly zh: "设为参考图";
        readonly en: "Set as reference";
        readonly ja: "参考画像に設定";
        readonly tok: "o kama sitelen lukin";
    };
    readonly "la.rotate90": {
        readonly zh: "旋转 90°";
        readonly en: "Rotate 90°";
        readonly ja: "90° 回転";
        readonly tok: "o sike (90°)";
    };
    readonly "la.resetTransform": {
        readonly zh: "复位（原始大小·画布居中）";
        readonly en: "Reset (original size, center on canvas)";
        readonly ja: "リセット（元のサイズ・中央配置）";
        readonly tok: "o kama sin: suli open la, o lon insa";
    };
    readonly "pick.sampleLabel": {
        readonly zh: "取样";
        readonly en: "Sample";
        readonly ja: "サンプル";
        readonly tok: "kama jo";
    };
    readonly "pick.sampleTip": {
        readonly zh: "吸色取样：合并最终颜色 / 当前图层原色";
        readonly en: "Eyedropper: merged final color / active layer color";
        readonly ja: "スポイト：合成後の色 / アクティブ層の色";
        readonly tok: "kama kule: kule pini pi lipu ale / kule pi lipu ni";
    };
    readonly "pick.composite": {
        readonly zh: "合并颜色";
        readonly en: "Merged";
        readonly ja: "合成";
        readonly tok: "kule pi lipu ale";
    };
    readonly "pick.active": {
        readonly zh: "当前图层";
        readonly en: "Active layer";
        readonly ja: "アクティブ層";
        readonly tok: "lipu ni";
    };
    readonly "palette.title": {
        readonly zh: "调色板";
        readonly en: "Palette";
        readonly ja: "パレット";
        readonly tok: "poki kule";
    };
    readonly "rack.sheet": {
        readonly zh: "笔架";
        readonly en: "Brush rack";
        readonly ja: "ブラシ棚";
        readonly tok: "poki pi ilo sitelen";
    };
    readonly "rack.importJson": {
        readonly zh: "导入笔架 JSON";
        readonly en: "Import rack JSON";
        readonly ja: "ブラシ棚JSONを読み込む";
        readonly tok: "o kama jo e poki tan lipu JSON";
    };
    readonly "rack.exportFolder": {
        readonly zh: "导出当前文件夹为 JSON";
        readonly en: "Export current folder as JSON";
        readonly ja: "現在のフォルダをJSONで書き出す";
        readonly tok: "o pana e poki ni tawa lipu JSON";
    };
    readonly "rack.refresh": {
        readonly zh: "从云端刷新笔架";
        readonly en: "Refresh rack from cloud";
        readonly ja: "クラウドからブラシ棚を更新";
        readonly tok: "o kama sama poki sewi";
    };
    readonly "rack.newBrush": {
        readonly zh: "新建笔刷";
        readonly en: "New brush";
        readonly ja: "新規ブラシ";
        readonly tok: "ilo sitelen sin";
    };
    readonly "bsv.title": {
        readonly zh: "笔刷设置";
        readonly en: "Brush settings";
        readonly ja: "ブラシ設定";
        readonly tok: "nasin pi ilo sitelen";
    };
    readonly "sg.checking": {
        readonly zh: "正在检查云端…";
        readonly en: "Checking cloud…";
        readonly ja: "クラウドを確認中…";
        readonly tok: "mi lukin e poki sewi…";
    };
    readonly "dim.width": {
        readonly zh: "宽 (px)";
        readonly en: "Width (px)";
        readonly ja: "幅 (px)";
        readonly tok: "suli poka (px)";
    };
    readonly "dim.height": {
        readonly zh: "高 (px)";
        readonly en: "Height (px)";
        readonly ja: "高さ (px)";
        readonly tok: "suli sewi (px)";
    };
    readonly "dim.interp": {
        readonly zh: "插值";
        readonly en: "Interpolation";
        readonly ja: "補間";
        readonly tok: "nasin ante";
    };
    readonly "interp.bicubic": {
        readonly zh: "双三次（默认 / 高质量）";
        readonly en: "Bicubic (default / high quality)";
        readonly ja: "バイキュービック（既定 / 高品質）";
        readonly tok: "pona mute (nasin open)";
    };
    readonly "interp.bilinear": {
        readonly zh: "双线性（软）";
        readonly en: "Bilinear (soft)";
        readonly ja: "バイリニア（柔らか）";
        readonly tok: "ko";
    };
    readonly "interp.nearest": {
        readonly zh: "最近邻（像素艺术 / 硬边）";
        readonly en: "Nearest (pixel art / hard edge)";
        readonly ja: "ニアレスト（ドット絵 / 硬いエッジ）";
        readonly tok: "kiwen (sitelen leko)";
    };
    readonly "ri.title": {
        readonly zh: "图片比画布大";
        readonly en: "Image larger than canvas";
        readonly ja: "画像がキャンバスより大きい";
        readonly tok: "sitelen li suli. supa li lili.";
    };
    readonly "ri.fit": {
        readonly zh: "缩到画布（默认）";
        readonly en: "Fit to canvas (default)";
        readonly ja: "キャンバスに合わせる（既定）";
        readonly tok: "o lili tawa supa (nasin open)";
    };
    readonly "ri.keep": {
        readonly zh: "保持原尺寸（layer 超出画布，可后调）";
        readonly en: "Keep original size (layer exceeds canvas; adjust later)";
        readonly ja: "元のサイズを維持（レイヤーがはみ出す、後で調整可）";
        readonly tok: "o awen e suli. lipu li suli tan supa. sina ken ante e ona lon tenpo kama.";
    };
    readonly "rs2.title": {
        readonly zh: "画布重采样";
        readonly en: "Resize canvas";
        readonly ja: "キャンバスをリサイズ";
        readonly tok: "ante suli pi supa sitelen";
    };
    readonly "rs2.lock": {
        readonly zh: "锁比例";
        readonly en: "Lock ratio";
        readonly ja: "比率をロック";
        readonly tok: "awen selo";
    };
    readonly "off.title": {
        readonly zh: "偏移接缝（环绕）";
        readonly en: "Offset seam (wrap)";
        readonly ja: "シームをずらす（ラップ）";
        readonly tok: "tawa sike";
    };
    readonly "off.x": {
        readonly zh: "水平 (px)";
        readonly en: "Horizontal (px)";
        readonly ja: "水平 (px)";
        readonly tok: "nasin poka (px)";
    };
    readonly "off.y": {
        readonly zh: "垂直 (px)";
        readonly en: "Vertical (px)";
        readonly ja: "垂直 (px)";
        readonly tok: "nasin sewi (px)";
    };
    readonly "off.half": {
        readonly zh: "居中接缝（半幅 ½）";
        readonly en: "Center seam (half ½)";
        readonly ja: "シームを中央に（半分 ½）";
        readonly tok: "tawa pi kipisi tu (½)";
    };
    readonly "crop.hint": {
        readonly zh: "裁切：拖角 / 边 / 框内移动";
        readonly en: "Crop: drag corner / edge / inside to move";
        readonly ja: "切り抜き：角 / 辺 / 内側をドラッグで移動";
        readonly tok: "kipisi: sina luka e selo la suli li ante · sina luka e insa la ona li tawa";
    };
    readonly "crop.mode": {
        readonly zh: "裁切模式";
        readonly en: "Crop mode";
        readonly ja: "切り抜きモード";
        readonly tok: "nasin kipisi";
    };
    readonly "crop.modeFree": {
        readonly zh: "自由";
        readonly en: "Free";
        readonly ja: "自由";
        readonly tok: "nasin ale";
    };
    readonly "crop.modeTemplate": {
        readonly zh: "定尺寸";
        readonly en: "Fixed size";
        readonly ja: "サイズ指定";
        readonly tok: "suli pini";
    };
    readonly "crop.fitCover": {
        readonly zh: "填充";
        readonly en: "Fill";
        readonly ja: "フィル";
        readonly tok: "insa ale";
    };
    readonly "crop.fitContain": {
        readonly zh: "适应";
        readonly en: "Fit";
        readonly ja: "フィット";
        readonly tok: "jo ale";
    };
    readonly "crop.customTpl": {
        readonly zh: "自定义…";
        readonly en: "Custom…";
        readonly ja: "カスタム…";
        readonly tok: "sina wile…";
    };
    readonly "crop.resample": {
        readonly zh: "调整分辨率（关=模板只作比例参考）";
        readonly en: "Resample to target size (off = ratio reference only)";
        readonly ja: "解像度を変更（オフ＝比率の参考のみ）";
        readonly tok: "ante e suli sitelen (open ala la sitelen li awen)";
    };
    readonly "crop.apply": {
        readonly zh: "裁切";
        readonly en: "Crop";
        readonly ja: "切り抜き";
        readonly tok: "kipisi";
    };
    readonly "crop.templated": {
        readonly zh: "已裁剪并缩放到 {w}×{h}";
        readonly en: "Cropped & scaled to {w}×{h}";
        readonly ja: "{w}×{h} に切り抜き＆拡縮した";
        readonly tok: "kipisi pini: suli li {w}×{h}";
    };
    readonly "fb.title": {
        readonly zh: "滤镜笔刷";
        readonly en: "Filter brush";
        readonly ja: "フィルターブラシ";
        readonly tok: "ilo sitelen pi ante kule";
    };
    readonly "color.title": {
        readonly zh: "颜色";
        readonly en: "Color";
        readonly ja: "カラー";
        readonly tok: "kule";
    };
    readonly "clr.aria": {
        readonly zh: "清空确认";
        readonly en: "Clear confirmation";
        readonly ja: "消去の確認";
        readonly tok: "toki pi weka ale";
    };
    readonly "clr.title": {
        readonly zh: "清空当前图层？";
        readonly en: "Clear current layer?";
        readonly ja: "現在のレイヤーを消去？";
        readonly tok: "sina wile ala wile weka e ale pi lipu ni?";
    };
    readonly "clr.msg": {
        readonly zh: "把当前图层的像素全部抹掉。可以 Ctrl+Z 撤销。";
        readonly en: "Erase all pixels on the current layer. Undo with Ctrl+Z.";
        readonly ja: "現在のレイヤーのピクセルをすべて消去します。Ctrl+Z で元に戻せます。";
        readonly tok: "ni li weka e kule ale pi lipu ni. sina ken weka e pali ni (Ctrl+Z).";
    };
    readonly "clr.confirm": {
        readonly zh: "清空";
        readonly en: "Clear";
        readonly ja: "消去";
        readonly tok: "o weka e ale";
    };
    readonly "upd.available": {
        readonly zh: "有新版本";
        readonly en: "New version available";
        readonly ja: "新しいバージョンあり";
        readonly tok: "mi ken kama sin";
    };
    readonly "upd.reload": {
        readonly zh: "刷新";
        readonly en: "Reload";
        readonly ja: "再読み込み";
        readonly tok: "o open sin";
    };
    readonly "upd.dismiss": {
        readonly zh: "忽略";
        readonly en: "Dismiss";
        readonly ja: "閉じる";
        readonly tok: "weka";
    };
    readonly "ss.saveCancelled": {
        readonly zh: "已取消保存";
        readonly en: "Save cancelled";
        readonly ja: "保存をキャンセルしました";
        readonly tok: "awen li weka";
    };
    readonly "ss.saved": {
        readonly zh: "已保存：{name}";
        readonly en: "Saved: {name}";
        readonly ja: "保存しました：{name}";
        readonly tok: "awen li pini: {name}";
    };
    readonly "ss.saveFailed": {
        readonly zh: "保存失败：{error}";
        readonly en: "Save failed: {error}";
        readonly ja: "保存に失敗しました：{error}";
        readonly tok: "awen li pakala: {error}";
    };
    readonly "ss.overwriteNewerTitle": {
        readonly zh: "覆盖更新版本写的画？";
        readonly en: "Overwrite artwork written by a newer version?";
        readonly ja: "新しいバージョンで作成された作品を上書きしますか？";
        readonly tok: "sitelen ni li tan ilo sin. sina wile ala wile awen e ona?";
    };
    readonly "ss.overwriteNewerMsg": {
        readonly zh: "这画由 {writer} 写的，你是 {version}。保存会丢失新版本特有的属性（如新图层 flag 等）。建议先刷新升级。";
        readonly en: "This artwork was written by {writer}; you're on {version}. Saving will lose properties specific to the newer version (such as new layer flags). Consider refreshing to upgrade first.";
        readonly ja: "この作品は {writer} で作成されましたが、あなたは {version} です。保存すると新しいバージョン固有の属性（新しいレイヤーフラグなど）が失われます。先に更新してアップグレードすることをおすすめします。";
        readonly tok: "ilo {writer} li sitelen e ona. taso sina kepeken e ilo {version}. sina awen la ijo pi ilo sin li weka. nasin pona: o open sin e mi lon tenpo open.";
    };
    readonly "ss.docNewerWarning": {
        readonly zh: "这画由 {writer} 写的，你是 {version} —— 编辑保存会丢失新版特有的层属性。建议先刷新升级。";
        readonly en: "This artwork was written by {writer}; you're on {version} — editing and saving will lose layer properties specific to the newer version. Consider refreshing to upgrade first.";
        readonly ja: "この作品は {writer} で作成されましたが、あなたは {version} です —— 編集・保存すると新しいバージョン固有のレイヤー属性が失われます。先に更新してアップグレードすることをおすすめします。";
        readonly tok: "ilo {writer} li sitelen e ona. taso sina kepeken e ilo {version}. sina ante la ijo pi ilo sin li weka. nasin pona: o open sin e mi.";
    };
    readonly "ss.noDocCannotSave": {
        readonly zh: "没打开作品，无法保存";
        readonly en: "No artwork open; cannot save";
        readonly ja: "作品が開かれていないため保存できません";
        readonly tok: "sitelen li open ala la awen li ken ala";
    };
    readonly "ss.notPushedNewer": {
        readonly zh: "未推送：这画由更新版本写成，你取消了覆盖（本地与云端都保持原样）";
        readonly en: "Not pushed: this artwork was written by a newer version and you cancelled the overwrite (local and cloud both left unchanged)";
        readonly ja: "プッシュしていません：この作品は新しいバージョンで作成されており、上書きをキャンセルしました（ローカルとクラウドはどちらもそのまま）";
        readonly tok: "mi pana ala: ilo sin li sitelen e ona. sina weka e awen. ilo ni en poki sewi li awen sama.";
    };
    readonly "ss.savedLocalIdb": {
        readonly zh: "已存本地：{name}（IDB 易失，登录云端更安全）";
        readonly en: "Saved locally: {name} (IndexedDB is volatile; sign in to the cloud for safety)";
        readonly ja: "ローカルに保存しました：{name}（IndexedDB は消えやすいため、クラウドにサインインすると安全です）";
        readonly tok: "awen lon ilo ni: {name}. ilo ni li ken weka e ijo. poki sewi li awen pona.";
    };
    readonly "ss.synced": {
        readonly zh: "已同步到云端：{name}";
        readonly en: "Synced to cloud: {name}";
        readonly ja: "クラウドに同期しました：{name}";
        readonly tok: "pana tawa poki sewi li pini: {name}";
    };
    readonly "ss.pushNotDone": {
        readonly zh: "没能推送到云端：{name}（离线或有冲突未解决，文件仍在本地）";
        readonly en: "Couldn't push to cloud: {name} (offline or unresolved conflict; the file is still local)";
        readonly ja: "クラウドに送信できませんでした：{name}（オフラインまたは未解決の競合。ファイルはローカルにあります）";
        readonly tok: "mi ken ala pana tawa poki sewi: {name}. ken la toki li ken ala. ken la ante tu li lon. sitelen li awen lon ilo ni.";
    };
    readonly "ss.savedNotPushed": {
        readonly zh: "已存本地，但没能上传到云端：{name}（稍后会重试）";
        readonly en: "Saved locally but the upload to cloud failed: {name} (will retry later)";
        readonly ja: "ローカルに保存しましたが、クラウドへの送信に失敗しました：{name}（後で再試行します）";
        readonly tok: "awen lon ilo ni: {name}. pana tawa poki sewi li pakala. mi pali sin lon tenpo kama.";
    };
    readonly "ss.pushFailed": {
        readonly zh: "推送失败：{error}";
        readonly en: "Push failed: {error}";
        readonly ja: "プッシュに失敗しました：{error}";
        readonly tok: "pana li pakala: {error}";
    };
    readonly "ss.openOrSaveBeforeEncrypt": {
        readonly zh: "先打开或保存一张画再加密";
        readonly en: "Open or save an artwork before encrypting";
        readonly ja: "暗号化する前に作品を開くか保存してください";
        readonly tok: "o open e sitelen lon tenpo open la sina ken len e ona";
    };
    readonly "ss.alreadyEncrypted": {
        readonly zh: "已是加密作品";
        readonly en: "Already an encrypted artwork";
        readonly ja: "すでに暗号化された作品です";
        readonly tok: "sitelen ni li len";
    };
    readonly "ss.cancelled": {
        readonly zh: "已取消";
        readonly en: "Cancelled";
        readonly ja: "キャンセルしました";
        readonly tok: "pali li weka";
    };
    readonly "ss.encryptingBusy": {
        readonly zh: "正在加密 {name}…";
        readonly en: "Encrypting {name}…";
        readonly ja: "{name} を暗号化しています…";
        readonly tok: "mi len e {name}…";
    };
    readonly "ss.encryptNeedsOnline": {
        readonly zh: "已同步过云端的作品需在线加密";
        readonly en: "Artworks already synced to the cloud must be encrypted online";
        readonly ja: "クラウドに同期済みの作品はオンラインで暗号化する必要があります";
        readonly tok: "sitelen li lon poki sewi kin. ilo li wile ken toki tawa poki sewi.";
    };
    readonly "ss.encryptedDeferred": {
        readonly zh: "已加密（本地完成；云端回线后推）：{name}";
        readonly en: "Encrypted (done locally; will push to cloud when back online): {name}";
        readonly ja: "暗号化しました（ローカルで完了。オンラインに戻ったらクラウドにプッシュ）：{name}";
        readonly tok: "len li pini (ilo ni taso. poki sewi li kama lon tenpo kama): {name}";
    };
    readonly "ss.encrypted": {
        readonly zh: "已加密：{name}（7-Zip 输此密码可恢复；忘记密码内容永久找不回）";
        readonly en: "Encrypted: {name} (recoverable with this password in 7-Zip; if you forget it the content is lost forever)";
        readonly ja: "暗号化しました：{name}（7-Zip でこのパスワードを入力すれば復元可能。パスワードを忘れると内容は永久に取り戻せません）";
        readonly tok: "len li lon: {name}. ilo \"7-Zip\" en nimi len ni li ken open e ona. sina weka e nimi len la sitelen li moli. sina ken ala open e ona lon tenpo ale.";
    };
    readonly "ss.encryptFailed": {
        readonly zh: "加密失败：{error}";
        readonly en: "Encryption failed: {error}";
        readonly ja: "暗号化に失敗しました：{error}";
        readonly tok: "len li pakala: {error}";
    };
    readonly "ss.noDocOpen": {
        readonly zh: "没打开作品";
        readonly en: "No artwork open";
        readonly ja: "作品が開かれていません";
        readonly tok: "sitelen li open ala";
    };
    readonly "ss.notEncrypted": {
        readonly zh: "这不是加密作品";
        readonly en: "This is not an encrypted artwork";
        readonly ja: "これは暗号化された作品ではありません";
        readonly tok: "sitelen ni li jo e len ala";
    };
    readonly "ss.decryptConfirmTitle": {
        readonly zh: "解除当前作品的加密？";
        readonly en: "Remove encryption from the current artwork?";
        readonly ja: "現在の作品の暗号化を解除しますか？";
        readonly tok: "sina wile ala wile weka e len tan sitelen ni?";
    };
    readonly "ss.decryptConfirmMsg": {
        readonly zh: "内容将以明文存放在本机与云端，任何能访问此设备或云账号的人都能查看。";
        readonly en: "The content will be stored in plain text locally and in the cloud; anyone with access to this device or cloud account can view it.";
        readonly ja: "内容はローカルとクラウドに平文で保存され、このデバイスやクラウドアカウントにアクセスできる人は誰でも閲覧できます。";
        readonly tok: "len li weka la sitelen li open tawa jan ale. ona li lon ilo ni li lon poki sewi. jan pi ken open li ken lukin e ona.";
    };
    readonly "ss.cancelledNeedPassword": {
        readonly zh: "已取消（需要密码）";
        readonly en: "Cancelled (password required)";
        readonly ja: "キャンセルしました（パスワードが必要です）";
        readonly tok: "pali li weka (nimi len li wile)";
    };
    readonly "ss.decryptingBusy": {
        readonly zh: "正在解除加密 {name}…";
        readonly en: "Removing encryption from {name}…";
        readonly ja: "{name} の暗号化を解除しています…";
        readonly tok: "mi weka e len tan {name}…";
    };
    readonly "ss.decryptNeedsOnline": {
        readonly zh: "已同步过云端的作品需在线解除加密";
        readonly en: "Artworks already synced to the cloud must be decrypted online";
        readonly ja: "クラウドに同期済みの作品はオンラインで暗号化を解除する必要があります";
        readonly tok: "sitelen li lon poki sewi kin. ilo li wile ken toki tawa poki sewi.";
    };
    readonly "ss.decrypted": {
        readonly zh: "已解除加密：{name}";
        readonly en: "Encryption removed: {name}";
        readonly ja: "暗号化を解除しました：{name}";
        readonly tok: "len li weka: {name}";
    };
    readonly "ss.decryptFailed": {
        readonly zh: "解除加密失败：{error}";
        readonly en: "Failed to remove encryption: {error}";
        readonly ja: "暗号化の解除に失敗しました：{error}";
        readonly tok: "weka len li pakala: {error}";
    };
    readonly "ss.renameTitleWith": {
        readonly zh: "重命名（{detail}）";
        readonly en: "Rename ({detail})";
        readonly ja: "名前を変更（{detail}）";
        readonly tok: "ante nimi ({detail})";
    };
    readonly "ss.renameTitle": {
        readonly zh: "重命名当前画作";
        readonly en: "Rename current artwork";
        readonly ja: "現在の作品の名前を変更";
        readonly tok: "ante nimi pi sitelen ni";
    };
    readonly "ss.artworkNamePlaceholder": {
        readonly zh: "作品名字";
        readonly en: "Artwork name";
        readonly ja: "作品名";
        readonly tok: "nimi sitelen";
    };
    readonly "ss.nameCannotBeEmpty": {
        readonly zh: "名字不能空";
        readonly en: "Name can't be empty";
        readonly ja: "名前は空にできません";
        readonly tok: "nimi li wile lon";
    };
    readonly "ss.renamingBusy": {
        readonly zh: "正在重命名 {oldName} → {newName}…";
        readonly en: "Renaming {oldName} → {newName}…";
        readonly ja: "{oldName} → {newName} に名前を変更しています…";
        readonly tok: "mi ante e nimi: {oldName} → {newName}…";
    };
    readonly "ss.renamedWithCloud": {
        readonly zh: "已重命名（含云端）：{oldName} → {newName}";
        readonly en: "Renamed (including cloud): {oldName} → {newName}";
        readonly ja: "名前を変更しました（クラウドを含む）：{oldName} → {newName}";
        readonly tok: "nimi li ante (lon poki sewi kin): {oldName} → {newName}";
    };
    readonly "ss.renamedOldKept": {
        readonly zh: "已另存为「{newName}」。云端的「{oldName}」原样留着（本地这份的来历不明，没敢动它）";
        readonly en: "Saved as \"{newName}\". The cloud copy \"{oldName}\" was left untouched (this local copy's lineage is unknown).";
        readonly ja: "「{newName}」として保存しました。クラウドの「{oldName}」はそのまま残しています（このローカル版の由来が不明なため）";
        readonly tok: "mi awen e ona kepeken nimi sin \"{newName}\". sitelen \"{oldName}\" pi poki sewi li awen sama. mi sona pona ala e tan ona la mi ante ala e ona.";
    };
    readonly "ss.renamedOldUnknown": {
        readonly zh: "已另存为「{newName}」。云端的「{oldName}」没能查到状态（离线？），所以没有动它——请稍后自行确认";
        readonly en: "Saved as \"{newName}\". Couldn't reach the cloud to check \"{oldName}\", so it was left alone — please verify later.";
        readonly ja: "「{newName}」として保存しました。クラウドの「{oldName}」の状態を確認できなかったため（オフライン？）、触れていません。後でご確認ください";
        readonly tok: "mi awen e ona kepeken nimi sin \"{newName}\". mi ken ala lukin e \"{oldName}\" lon poki sewi. mi ante ala e ona. o lukin lon tenpo kama.";
    };
    readonly "ss.renamedLocalOnly": {
        readonly zh: "已重命名为「{newName}」，但云端没推成功——目前只在本地，稍后会重试";
        readonly en: "Renamed to \"{newName}\", but the cloud push failed — it's local-only for now and will retry later.";
        readonly ja: "「{newName}」に名前を変更しましたが、クラウドへの送信に失敗しました。現在はローカルのみで、後で再試行します";
        readonly tok: "nimi sin li lon: \"{newName}\". taso pana tawa poki sewi li pakala. ona li lon ilo ni taso. mi pali sin lon tenpo kama.";
    };
    readonly "ss.renamedOldOrphan": {
        readonly zh: "已重命名为「{newName}」，但云端的「{oldName}」没能移进回收站，仍留在原处";
        readonly en: "Renamed to \"{newName}\", but the cloud copy \"{oldName}\" couldn't be moved to the recycle bin and remains in place.";
        readonly ja: "「{newName}」に名前を変更しましたが、クラウドの「{oldName}」をごみ箱に移動できず、元の場所に残っています";
        readonly tok: "nimi sin li lon: \"{newName}\". taso \"{oldName}\" pi poki sewi li ken ala tawa poki jaki. ona li awen lon ma ona.";
    };
    readonly "ss.renameFailed": {
        readonly zh: "重命名失败：{error}";
        readonly en: "Rename failed: {error}";
        readonly ja: "名前の変更に失敗しました：{error}";
        readonly tok: "ante nimi li pakala: {error}";
    };
    readonly "ss.localNameTakenStatus": {
        readonly zh: "本地已有同名 \"{name}\"，换一个";
        readonly en: "\"{name}\" already exists locally; choose another";
        readonly ja: "ローカルに同名の「{name}」がすでにあります。別の名前にしてください";
        readonly tok: "nimi sama \"{name}\" li lon ilo ni. o ante.";
    };
    readonly "ss.nameTakenNote": {
        readonly zh: "已有同名 \"{name}\"，换一个";
        readonly en: "\"{name}\" already exists; choose another";
        readonly ja: "同名の「{name}」がすでにあります。別の名前にしてください";
        readonly tok: "nimi sama \"{name}\" li lon. o ante.";
    };
    readonly "ss.savingBusy": {
        readonly zh: "正在保存 {name}…";
        readonly en: "Saving {name}…";
        readonly ja: "{name} を保存しています…";
        readonly tok: "mi awen e {name}…";
    };
    readonly "ss.localSaveIncompleteTitle": {
        readonly zh: "本地保存未完成";
        readonly en: "Local save incomplete";
        readonly ja: "ローカル保存が完了していません";
        readonly tok: "awen li pini ala";
    };
    readonly "ss.localSaveIncompleteMsg": {
        readonly zh: "「{name}」的修改还没写进本地存储（保存失败或被取消）。直接退出会丢这些修改。";
        readonly en: "Changes to \"{name}\" haven't been written to local storage (save failed or was cancelled). Exiting now will lose these changes.";
        readonly ja: "「{name}」の変更はまだローカルストレージに書き込まれていません（保存に失敗またはキャンセルされました）。このまま終了すると変更が失われます。";
        readonly tok: "ante pi sitelen \"{name}\" li awen ala lon ilo ni (awen li pakala anu weka). sina tawa weka la ante ni li moli.";
    };
    readonly "ss.retrySave": {
        readonly zh: "重试保存";
        readonly en: "Retry save";
        readonly ja: "保存を再試行";
        readonly tok: "o awen sin";
    };
    readonly "ss.exitDiscard": {
        readonly zh: "仍要退出（丢弃本次修改）";
        readonly en: "Exit anyway (discard these changes)";
        readonly ja: "それでも終了する（この変更を破棄）";
        readonly tok: "weka (ante li moli)";
    };
    readonly "ss.notFound": {
        readonly zh: "找不到：{name}";
        readonly en: "Not found: {name}";
        readonly ja: "見つかりません：{name}";
        readonly tok: "mi ken ala lukin e ona: {name}";
    };
    readonly "ss.notOpenedNeedPasswordCancelled": {
        readonly zh: "未打开：需要密码解锁（已取消）";
        readonly en: "Not opened: password required to unlock (cancelled)";
        readonly ja: "開いていません：ロック解除にパスワードが必要です（キャンセルしました）";
        readonly tok: "open ala: nimi len li wile (pali li weka)";
    };
    readonly "ss.opened": {
        readonly zh: "已打开：{name}";
        readonly en: "Opened: {name}";
        readonly ja: "開きました：{name}";
        readonly tok: "open li pini: {name}";
    };
    readonly "ss.openFailed": {
        readonly zh: "打开失败：{error}";
        readonly en: "Open failed: {error}";
        readonly ja: "開くのに失敗しました：{error}";
        readonly tok: "open li pakala: {error}";
    };
    readonly "ss.notPushedNeedPassword": {
        readonly zh: "未推送：需要密码解锁（已取消）";
        readonly en: "Not pushed: password required to unlock (cancelled)";
        readonly ja: "プッシュしていません：ロック解除にパスワードが必要です（キャンセルしました）";
        readonly tok: "pana ala: nimi len li wile (pali li weka)";
    };
    readonly "ss.pushingToCloudBusy": {
        readonly zh: "正在推送 {name} 到云端…";
        readonly en: "Pushing {name} to the cloud…";
        readonly ja: "{name} をクラウドにプッシュしています…";
        readonly tok: "mi pana e {name} tawa poki sewi…";
    };
    readonly "ss.pushed": {
        readonly zh: "已推送：{name}";
        readonly en: "Pushed: {name}";
        readonly ja: "プッシュしました：{name}";
        readonly tok: "pana li pini: {name}";
    };
    readonly "ss.unloadingBusy": {
        readonly zh: "正在卸载本地 {name}…";
        readonly en: "Unloading local {name}…";
        readonly ja: "ローカルの {name} をアンロードしています…";
        readonly tok: "mi weka e {name} tan ilo ni…";
    };
    readonly "ss.unloaded": {
        readonly zh: "已卸载本地：{name}（修改在本地回收站，云端保留）";
        readonly en: "Unloaded local: {name} (changes are in the local trash; the cloud is kept)";
        readonly ja: "ローカルをアンロードしました：{name}（変更はローカルのゴミ箱にあり、クラウドは保持されます）";
        readonly tok: "weka tan ilo ni li pini: {name}. ante li lon poki jaki pi ilo ni. poki sewi li awen jo.";
    };
    readonly "ss.unloadFailed": {
        readonly zh: "卸载失败：{error}";
        readonly en: "Unload failed: {error}";
        readonly ja: "アンロードに失敗しました：{error}";
        readonly tok: "weka li pakala: {error}";
    };
    readonly "tm.clearedActiveLayer": {
        readonly zh: "已清空当前图层（Ctrl+Z 撤销）";
        readonly en: "Active layer cleared (Ctrl+Z to undo)";
        readonly ja: "現在のレイヤーを消去しました（Ctrl+Z で取り消し）";
        readonly tok: "mi weka e ale pi lipu ni (Ctrl+Z)";
    };
    readonly "tm.saveAs": {
        readonly zh: "另存为";
        readonly en: "Save As";
        readonly ja: "名前を付けて保存";
        readonly tok: "awen kepeken nimi sin";
    };
    readonly "tm.newArtworkNamePlaceholder": {
        readonly zh: "新作品名字";
        readonly en: "New artwork name";
        readonly ja: "新しい作品名";
        readonly tok: "nimi pi sitelen sin";
    };
    readonly "tm.nameEmpty": {
        readonly zh: "名字不能空";
        readonly en: "Name can't be empty";
        readonly ja: "名前を空にできません";
        readonly tok: "nimi li wile lon";
    };
    readonly "tm.nameSameAsCurrent": {
        readonly zh: "名字和当前一样，换一个";
        readonly en: "Same as current name, choose another";
        readonly ja: "現在の名前と同じです。別の名前にしてください";
        readonly tok: "nimi li ante ala. o pana e nimi ante.";
    };
    readonly "tm.cloudNameExists": {
        readonly zh: "云端已有同名 \"{name}\"，换一个";
        readonly en: "A cloud file named \"{name}\" already exists, choose another";
        readonly ja: "クラウドに同名 \"{name}\" が既にあります。別の名前にしてください";
        readonly tok: "nimi \"{name}\" li lon poki sewi. o pana e nimi ante.";
    };
    readonly "tm.nameExists": {
        readonly zh: "已有同名 \"{name}\"（本地或云端），换一个";
        readonly en: "A file named \"{name}\" already exists (local or cloud), choose another";
        readonly ja: "同名 \"{name}\" が既にあります（ローカルまたはクラウド）。別の名前にしてください";
        readonly tok: "nimi \"{name}\" li lon (ilo ni anu poki sewi). o pana e nimi ante.";
    };
    readonly "tm.savedAsWithCloud": {
        readonly zh: "已另存为（含云端）：{name}";
        readonly en: "Saved as (incl. cloud): {name}";
        readonly ja: "名前を付けて保存しました（クラウド含む）：{name}";
        readonly tok: "mi awen e ona kepeken nimi sin (lon poki sewi kin): {name}";
    };
    readonly "tm.saveAsFailed": {
        readonly zh: "另存为失败：{err}";
        readonly en: "Save As failed: {err}";
        readonly ja: "名前を付けて保存に失敗しました：{err}";
        readonly tok: "awen li pakala: {err}";
    };
    readonly "tm.noActiveSession": {
        readonly zh: "没活动 session";
        readonly en: "No active session";
        readonly ja: "アクティブなセッションがありません";
        readonly tok: "sitelen li open ala";
    };
    readonly "tm.noOpenSnapshot": {
        readonly zh: "没找到本次打开时的快照";
        readonly en: "No snapshot from when this was opened";
        readonly ja: "開いた時点のスナップショットが見つかりません";
        readonly tok: "sitelen pi tenpo open li lon ala";
    };
    readonly "tm.revertTitle": {
        readonly zh: "撤销修改";
        readonly en: "Revert changes";
        readonly ja: "変更を元に戻す";
        readonly tok: "kama sin tawa tenpo pini";
    };
    readonly "tm.revertMessage": {
        readonly zh: "回到约 {min} 分钟前的快照（本次打开或上次保存时的版本）。\n之后所有修改将丢失。";
        readonly en: "Revert to the snapshot from about {min} minutes ago (when opened or last saved). All changes after that will be lost.";
        readonly ja: "約 {min} 分前のスナップショット（開いた時または最後に保存した時の状態）に戻ります。\nそれ以降の変更はすべて失われます。";
        readonly tok: "sitelen li kama sama tenpo pini ({min} tenpo lili). ante ale pi tenpo ni li weka. sina ken ala weka e pali ni.";
    };
    readonly "tm.cancel": {
        readonly zh: "取消";
        readonly en: "Cancel";
        readonly ja: "キャンセル";
        readonly tok: "weka";
    };
    readonly "tm.revert": {
        readonly zh: "撤销";
        readonly en: "Revert";
        readonly ja: "元に戻す";
        readonly tok: "o kama sin";
    };
    readonly "tm.revertFailedNeedPassword": {
        readonly zh: "恢复失败：需要密码解锁";
        readonly en: "Restore failed: password required to unlock";
        readonly ja: "復元に失敗しました：ロック解除にパスワードが必要です";
        readonly tok: "kama sin li pakala: nimi len li wile";
    };
    readonly "tm.revertedToOpen": {
        readonly zh: "已恢复到本次打开时（{min} 分钟前）";
        readonly en: "Restored to when opened ({min} minutes ago)";
        readonly ja: "開いた時点に復元しました（{min} 分前）";
        readonly tok: "mi kama sin e sitelen pi tenpo open ({min} tenpo lili pini)";
    };
    readonly "tm.revertFailed": {
        readonly zh: "恢复失败：{err}";
        readonly en: "Restore failed: {err}";
        readonly ja: "復元に失敗しました：{err}";
        readonly tok: "kama sin li pakala: {err}";
    };
    readonly "tm.viewportReset": {
        readonly zh: "视口已复位";
        readonly en: "Viewport reset";
        readonly ja: "ビューをリセットしました";
        readonly tok: "lukin li kama sin";
    };
    readonly "tm.forceResetTitle": {
        readonly zh: "强制清缓存重启？";
        readonly en: "Force-clear cache and restart?";
        readonly ja: "キャッシュを強制的にクリアして再起動しますか？";
        readonly tok: "o weka e poki tenpo o open sin";
    };
    readonly "tm.forceResetBody": {
        readonly zh: "会清掉 SW + Cache Storage，强制重新拉所有 JS / CSS。你的画 / 笔架（IDB / OneDrive）不会动。\n用途：PWA 卡老版本，点更新还是老的时候用。";
        readonly en: "Clears the SW + Cache Storage and force-refetches all JS / CSS. Your artwork / brush rack (IDB / OneDrive) is untouched.\nUse when the PWA is stuck on an old version and Update doesn't help.";
        readonly ja: "SW と Cache Storage を消去し、すべての JS / CSS を強制的に再取得します。作品 / ブラシラック（IDB / OneDrive）はそのままです。\n用途：PWA が古いバージョンで固まり、更新を押しても変わらない時に使います。";
        readonly tok: "mi weka e poki tenpo. mi kama jo sin e ijo ale mi. sitelen sina en poki pi ilo sitelen li awen pona. mi awen lon nanpa pini la o kepeken e ni.";
    };
    readonly "tm.cacheClearedReloading": {
        readonly zh: "已清缓存，正在硬重载…";
        readonly en: "Cache cleared, hard-reloading…";
        readonly ja: "キャッシュを消去しました。強制再読み込み中…";
        readonly tok: "poki tenpo li weka. mi open sin…";
    };
    readonly "tm.cacheClearFailed": {
        readonly zh: "清缓存失败：{err}";
        readonly en: "Failed to clear cache: {err}";
        readonly ja: "キャッシュの消去に失敗しました：{err}";
        readonly tok: "weka li pakala: {err}";
    };
    readonly "tm.resetRackTitle": {
        readonly zh: "还原内置笔刷？";
        readonly en: "Restore built-in brushes?";
        readonly ja: "内蔵ブラシを復元しますか？";
        readonly tok: "sina wile ala wile kama sin e ilo pi tan open?";
    };
    readonly "tm.resetRackBody": {
        readonly zh: "把内置笔刷恢复成出厂设置，并排到各分组最前。你自己新建或导入的笔刷不会被删除；只有内置笔上的改动会被覆盖。";
        readonly en: "Restores the built-in brushes to their factory settings and moves them to the top of each folder. Your own brushes are not deleted — only edits made to built-in brushes are overwritten.";
        readonly ja: "内蔵ブラシを工場出荷時の設定に戻し、各フォルダーの先頭に並べ替えます。自作・読み込んだブラシは削除されません。内蔵ブラシへの変更のみ上書きされます。";
        readonly tok: "ilo pi tan open li kama sama open. ona li tawa sewi poki. ilo pi pali sina li weka ala. taso, sina ante e ilo pi tan open la ante ni li weka.";
    };
    readonly "tm.rackRestored": {
        readonly zh: "已还原 {count} 支内置笔刷";
        readonly en: "Restored {count} built-in brushes";
        readonly ja: "内蔵ブラシ {count} 本を復元しました";
        readonly tok: "mi kama sin e ilo pi tan open ({count})";
    };
    readonly "tm.rotationResetForCrop": {
        readonly zh: "已复位画布旋转以进入自由裁切";
        readonly en: "Canvas rotation reset to enter free crop";
        readonly ja: "自由トリミングに入るためキャンバスの回転をリセットしました";
        readonly tok: "sike supa li kama sin. kipisi li open.";
    };
    readonly "tm.noSelectionDrawLasso": {
        readonly zh: "没选区——画一个 lasso 选区先";
        readonly en: "No selection — draw a lasso selection first";
        readonly ja: "選択範囲がありません——先に投げ縄で選択してください";
        readonly tok: "ma wile li lon ala. o sitelen e ma wile kepeken ilo pi ma wile.";
    };
    readonly "tm.selectionTooSmall": {
        readonly zh: "选区太小或在画布外";
        readonly en: "Selection too small or outside the canvas";
        readonly ja: "選択範囲が小さすぎるか、キャンバスの外です";
        readonly tok: "ma wile li lili ike. ken la ona li lon ala supa.";
    };
    readonly "tm.croppedToSelection": {
        readonly zh: "已裁到选区：{w}×{h}";
        readonly en: "Cropped to selection: {w}×{h}";
        readonly ja: "選択範囲でトリミングしました：{w}×{h}";
        readonly tok: "mi kipisi tawa ma wile: {w}×{h}";
    };
    readonly "tm.flippedHorizontal": {
        readonly zh: "已水平翻转";
        readonly en: "Flipped horizontally";
        readonly ja: "左右反転しました";
        readonly tok: "mi jasima e poka sitelen";
    };
    readonly "tm.rotated90CCW": {
        readonly zh: "已逆时针旋转 90°";
        readonly en: "Rotated 90° counter-clockwise";
        readonly ja: "反時計回りに 90° 回転しました";
        readonly tok: "mi sike e sitelen (90°)";
    };
    readonly "tm.cropped": {
        readonly zh: "已裁切：{w}×{h}";
        readonly en: "Cropped: {w}×{h}";
        readonly ja: "トリミングしました：{w}×{h}";
        readonly tok: "mi kipisi: {w}×{h}";
    };
    readonly "tm.sizeOutOfRange": {
        readonly zh: "尺寸超出 [1, 8192]";
        readonly en: "Size out of range [1, 8192]";
        readonly ja: "サイズが範囲外です [1, 8192]";
        readonly tok: "suli li lon ala poki nanpa [1, 8192]";
    };
    readonly "tm.resampled": {
        readonly zh: "已重采样到 {w}×{h}（{mode}）";
        readonly en: "Resampled to {w}×{h} ({mode})";
        readonly ja: "{w}×{h} にリサンプリングしました（{mode}）";
        readonly tok: "mi ante e suli: {w}×{h} ({mode})";
    };
    readonly "tm.offset": {
        readonly zh: "已偏移 {dx},{dy}（环绕）";
        readonly en: "Offset {dx},{dy} (wrap)";
        readonly ja: "{dx},{dy} オフセットしました（ラップ）";
        readonly tok: "mi tawa sike e sitelen: {dx},{dy}";
    };
    readonly "tm.dotExtDownloaded": {
        readonly zh: ".{ext} 已下载";
        readonly en: ".{ext} downloaded";
        readonly ja: ".{ext} をダウンロードしました";
        readonly tok: "lipu .{ext} li kama lon ilo sina";
    };
    readonly "tm.exportFailed": {
        readonly zh: "导出失败：{err}";
        readonly en: "Export failed: {err}";
        readonly ja: "エクスポートに失敗しました：{err}";
        readonly tok: "pana li pakala: {err}";
    };
    readonly "tm.exportNoCipher": {
        readonly zh: "取不到加密字节（本地无副本？），导出已取消。";
        readonly en: "Could not read the encrypted bytes (no local copy?); export cancelled.";
        readonly ja: "暗号化されたバイトを取得できませんでした（ローカルにコピーがない？）。エクスポートを中止しました。";
        readonly tok: "mi ken ala jo e ijo len (ilo ni li jo ala e ona). pana li pini.";
    };
    readonly "tm.copiedPngToClipboard": {
        readonly zh: "已复制 PNG 到剪贴板（{scope}）";
        readonly en: "Copied PNG to clipboard ({scope})";
        readonly ja: "PNG をクリップボードにコピーしました（{scope}）";
        readonly tok: "mi pana e sitelen PNG tawa poki kipisi ({scope})";
    };
    readonly "tm.scopeActiveLayer": {
        readonly zh: "当前层";
        readonly en: "active layer";
        readonly ja: "現在のレイヤー";
        readonly tok: "lipu ni";
    };
    readonly "tm.scopeMerged": {
        readonly zh: "合并";
        readonly en: "merged";
        readonly ja: "統合";
        readonly tok: "wan pi lipu ale";
    };
    readonly "tm.printOpenedNewTab": {
        readonly zh: "已在新标签页打开打印";
        readonly en: "Opened print in a new tab";
        readonly ja: "新しいタブで印刷を開きました";
        readonly tok: "ilo lipu li open lon lupa sin";
    };
    readonly "tm.popupBlockedInlinePrint": {
        readonly zh: "弹窗被拦，改用页内打印——若丢图请在 Safari 允许本站弹窗后重试";
        readonly en: "Popup blocked, using inline print — if the image is missing, allow popups for this site in Safari and retry";
        readonly ja: "ポップアップがブロックされたためページ内印刷を使用します——画像が欠ける場合は Safari でこのサイトのポップアップを許可して再試行してください";
        readonly tok: "lupa sin li ken ala open. mi kepeken e nasin ante. sitelen li weka la o ken e lupa sin lon ilo \"Safari\". o pali sin.";
    };
    readonly "tm.sharePanelOpened": {
        readonly zh: "分享面板已开";
        readonly en: "Share panel opened";
        readonly ja: "共有パネルを開きました";
        readonly tok: "lupa pana li open";
    };
    readonly "tm.shareCancelled": {
        readonly zh: "取消分享";
        readonly en: "Share cancelled";
        readonly ja: "共有をキャンセルしました";
        readonly tok: "pana li weka";
    };
    readonly "tm.extDownloadedUpper": {
        readonly zh: "{ext} 已下载";
        readonly en: "{ext} downloaded";
        readonly ja: "{ext} をダウンロードしました";
        readonly tok: "lipu {ext} li kama lon ilo sina";
    };
    readonly "tm.clipboardNoImage": {
        readonly zh: "剪贴板里没有图片";
        readonly en: "No image in the clipboard";
        readonly ja: "クリップボードに画像がありません";
        readonly tok: "sitelen li lon ala poki kipisi";
    };
    readonly "tm.clipboardPasteFailed": {
        readonly zh: "从剪贴板粘贴失败：{err}";
        readonly en: "Paste from clipboard failed: {err}";
        readonly ja: "クリップボードからの貼り付けに失敗しました：{err}";
        readonly tok: "kama jo tan poki kipisi li pakala: {err}";
    };
    readonly "tm.configFormat": {
        readonly zh: "格式";
        readonly en: "Format";
        readonly ja: "形式";
        readonly tok: "nasin lipu";
    };
    readonly "tm.configScope": {
        readonly zh: "图层";
        readonly en: "Layers";
        readonly ja: "レイヤー";
        readonly tok: "lipu";
    };
    readonly "tm.scopeAllLayers": {
        readonly zh: "所有图层（含隐藏）";
        readonly en: "All layers (incl. hidden)";
        readonly ja: "すべてのレイヤー（非表示含む）";
        readonly tok: "lipu ale (lipu pi lukin ala kin)";
    };
    readonly "tm.mergeAllVisible": {
        readonly zh: "合并所有可见层";
        readonly en: "Merge all visible layers";
        readonly ja: "表示中の全レイヤーを統合";
        readonly tok: "wan pi lipu lukin ale";
    };
    readonly "tm.onlyActiveLayer": {
        readonly zh: "仅当前层";
        readonly en: "Active layer only";
        readonly ja: "現在のレイヤーのみ";
        readonly tok: "lipu ni taso";
    };
    readonly "tm.configTarget": {
        readonly zh: "去向";
        readonly en: "Destination";
        readonly ja: "出力先";
        readonly tok: "tawa";
    };
    readonly "tm.targetFile": {
        readonly zh: "文件";
        readonly en: "File";
        readonly ja: "ファイル";
        readonly tok: "lipu";
    };
    readonly "tm.targetClipboard": {
        readonly zh: "剪切板";
        readonly en: "Clipboard";
        readonly ja: "クリップボード";
        readonly tok: "poki kipisi";
    };
    readonly "tm.targetPrint": {
        readonly zh: "打印";
        readonly en: "Print";
        readonly ja: "印刷";
        readonly tok: "ilo lipu";
    };
    readonly "tm.configSource": {
        readonly zh: "来源";
        readonly en: "Source";
        readonly ja: "ソース";
        readonly tok: "tan";
    };
    readonly "bl.connected": {
        readonly zh: "已连接";
        readonly en: "Connected";
        readonly ja: "接続済み";
        readonly tok: "toki li lon";
    };
    readonly "bl.connecting": {
        readonly zh: "连接中…";
        readonly en: "Connecting…";
        readonly ja: "接続中…";
        readonly tok: "mi open e toki…";
    };
    readonly "bl.connectBlender": {
        readonly zh: "连接 Blender";
        readonly en: "Connect Blender";
        readonly ja: "Blender に接続";
        readonly tok: "o toki tawa ilo \"Blender\"";
    };
    readonly "bl.localMachine": {
        readonly zh: "本机";
        readonly en: "Local";
        readonly ja: "ローカル";
        readonly tok: "ilo ni";
    };
    readonly "bl.connectedHost": {
        readonly zh: "已连接 {host}";
        readonly en: "Connected {host}";
        readonly ja: "接続済み {host}";
        readonly tok: "toki li lon: {host}";
    };
    readonly "bl.connectedLocal": {
        readonly zh: "已连接 Blender（本机）";
        readonly en: "Connected to Blender (local)";
        readonly ja: "Blender に接続済み（ローカル）";
        readonly tok: "toki li lon: ilo \"Blender\" (ilo ni)";
    };
    readonly "bl.cannotConnectHost": {
        readonly zh: "连不上 {host} —— 确认 Blender 已开端口、该地址可达（如 tailscale serve）";
        readonly en: "Cannot connect to {host} — make sure Blender's port is open and the address is reachable (e.g. tailscale serve)";
        readonly ja: "{host} に接続できません —— Blender がポートを開いていて、そのアドレスに到達可能か確認してください（例：tailscale serve）";
        readonly tok: "mi ken ala toki tawa {host}. o open e lupa toki lon ilo \"Blender\". o lukin e ni: nasin li ken kama.";
    };
    readonly "bl.cannotConnectLocal": {
        readonly zh: "连不上本机 Blender —— 先在 Blender 的 BTP 面板里开启端口";
        readonly en: "Cannot connect to local Blender — open the port in Blender's BTP panel first";
        readonly ja: "ローカルの Blender に接続できません —— まず Blender の BTP パネルでポートを開いてください";
        readonly tok: "mi ken ala toki tawa ilo \"Blender\". o open e lupa toki lon lupa BTP lon tenpo open.";
    };
    readonly "bl.textureListFailed": {
        readonly zh: "拉取贴图列表失败：{error}";
        readonly en: "Failed to fetch texture list: {error}";
        readonly ja: "テクスチャ一覧の取得に失敗：{error}";
        readonly tok: "kama jo pi nimi sitelen li pakala: {error}";
    };
    readonly "bl.connectFirst": {
        readonly zh: "请先连接 Blender";
        readonly en: "Connect to Blender first";
        readonly ja: "先に Blender へ接続してください";
        readonly tok: "o toki tawa ilo \"Blender\" lon tenpo open";
    };
    readonly "bl.usedSelectedTexture": {
        readonly zh: "已用 Blender 选中贴图：{name}";
        readonly en: "Using texture selected in Blender: {name}";
        readonly ja: "Blender で選択中のテクスチャを使用：{name}";
        readonly tok: "mi kepeken e sitelen wile pi ilo \"Blender\": {name}";
    };
    readonly "bl.noSelectedTexture": {
        readonly zh: "Blender 里没有选中贴图";
        readonly en: "No texture selected in Blender";
        readonly ja: "Blender でテクスチャが選択されていません";
        readonly tok: "sitelen wile li lon ala ilo \"Blender\"";
    };
    readonly "bl.readSelectionFailed": {
        readonly zh: "读取选中失败：{error}";
        readonly en: "Failed to read selection: {error}";
        readonly ja: "選択の読み取りに失敗：{error}";
        readonly tok: "lukin pi sitelen wile li pakala: {error}";
    };
    readonly "bl.enterTextureName": {
        readonly zh: "请填贴图名";
        readonly en: "Enter a texture name";
        readonly ja: "テクスチャ名を入力してください";
        readonly tok: "o pana e nimi sitelen";
    };
    readonly "bl.pushing": {
        readonly zh: "正在推送到 Blender…";
        readonly en: "Pushing to Blender…";
        readonly ja: "Blender へ送信中…";
        readonly tok: "mi pana tawa ilo \"Blender\"…";
    };
    readonly "bl.pushed": {
        readonly zh: "已推送「{name}」到 Blender";
        readonly en: "Pushed \"{name}\" to Blender";
        readonly ja: "「{name}」を Blender へ送信しました";
        readonly tok: "pana li pini: \"{name}\" li lon ilo \"Blender\"";
    };
    readonly "bl.withReference": {
        readonly zh: "（含参考图）";
        readonly en: " (with reference)";
        readonly ja: "（参考画像を含む）";
        readonly tok: " (sitelen lukin kin)";
    };
    readonly "bl.pushFailed": {
        readonly zh: "推送失败：{error}";
        readonly en: "Push failed: {error}";
        readonly ja: "送信に失敗：{error}";
        readonly tok: "pana li pakala: {error}";
    };
    readonly "bl.layerLimit": {
        readonly zh: "图层已达上限（{max}）";
        readonly en: "Layer limit reached ({max})";
        readonly ja: "レイヤー数が上限に達しました（{max}）";
        readonly tok: "lipu li mute sewi ({max})";
    };
    readonly "bl.pulling": {
        readonly zh: "正在从 Blender 拉取…";
        readonly en: "Pulling from Blender…";
        readonly ja: "Blender から取得中…";
        readonly tok: "mi kama jo tan ilo \"Blender\"…";
    };
    readonly "bl.pulled": {
        readonly zh: "已拉取「{name}」→ {target}";
        readonly en: "Pulled \"{name}\" → {target}";
        readonly ja: "「{name}」を{target}へ取得しました";
        readonly tok: "kama jo li pini: \"{name}\" → {target}";
    };
    readonly "bl.newLayer": {
        readonly zh: "新图层";
        readonly en: "New layer";
        readonly ja: "新規レイヤー";
        readonly tok: "lipu sin";
    };
    readonly "bl.currentLayer": {
        readonly zh: "当前图层";
        readonly en: "Current layer";
        readonly ja: "現在のレイヤー";
        readonly tok: "lipu ni";
    };
    readonly "bl.pullFailed": {
        readonly zh: "拉取失败：{error}";
        readonly en: "Pull failed: {error}";
        readonly ja: "取得に失敗：{error}";
        readonly tok: "kama jo li pakala: {error}";
    };
    readonly "bl.overwriteCurrent": {
        readonly zh: "覆盖当前";
        readonly en: "Overwrite current";
        readonly ja: "現在を上書き";
        readonly tok: "lipu ni (insa pini li weka)";
    };
    readonly "bl.mergedCanvas": {
        readonly zh: "合并画布";
        readonly en: "Merged canvas";
        readonly ja: "統合キャンバス";
        readonly tok: "wan pi lipu ale";
    };
    readonly "bl.activeLayerGroup": {
        readonly zh: "当前图层组";
        readonly en: "Current layer group";
        readonly ja: "現在のレイヤーグループ";
        readonly tok: "kulupu ni";
    };
    readonly "bl.plusRef": {
        readonly zh: " · +参考";
        readonly en: " · +ref";
        readonly ja: " · +参考";
        readonly tok: " · sitelen lukin kin";
    };
    readonly "bl.panelTitle": {
        readonly zh: "Blender 同步";
        readonly en: "Blender Sync";
        readonly ja: "Blender 同期";
        readonly tok: "kama sama pi ilo \"Blender\"";
    };
    readonly "bl.close": {
        readonly zh: "关闭";
        readonly en: "Close";
        readonly ja: "閉じる";
        readonly tok: "pini";
    };
    readonly "bl.remoteUrlPlaceholder": {
        readonly zh: "远程地址（留空 = 本机 127.0.0.1）";
        readonly en: "Remote address (blank = local 127.0.0.1)";
        readonly ja: "リモートアドレス（空欄 = ローカル 127.0.0.1）";
        readonly tok: "nasin pi ilo ante (ala = ilo ni)";
    };
    readonly "bl.remoteUrlTitle": {
        readonly zh: "另一台设备：填能连到 Blender 的 HTTPS 地址，例如 tailscale serve 的 https://pc.tailnet.ts.net";
        readonly en: "Another device: enter an HTTPS address that reaches Blender, e.g. tailscale serve's https://pc.tailnet.ts.net";
        readonly ja: "別のデバイス：Blender に到達できる HTTPS アドレスを入力（例：tailscale serve の https://pc.tailnet.ts.net）";
        readonly tok: "sina kepeken e ilo ante la o pana e nasin HTTPS. ona li wile ken kama tawa ilo \"Blender\".";
    };
    readonly "bl.textureNameLabel": {
        readonly zh: "贴图名（= 标识）";
        readonly en: "Texture name (= identifier)";
        readonly ja: "テクスチャ名（= 識別子）";
        readonly tok: "nimi sitelen";
    };
    readonly "bl.imageNamePlaceholder": {
        readonly zh: "image 名字";
        readonly en: "image name";
        readonly ja: "image 名";
        readonly tok: "nimi \"image\"";
    };
    readonly "bl.useSelBtn": {
        readonly zh: "选中";
        readonly en: "Selected";
        readonly ja: "選択中";
        readonly tok: "sitelen wile";
    };
    readonly "bl.useSelTitle": {
        readonly zh: "用 Blender 当前选中";
        readonly en: "Use Blender's current selection";
        readonly ja: "Blender の現在の選択を使用";
        readonly tok: "o kepeken e sitelen wile pi ilo \"Blender\"";
    };
    readonly "bl.refreshBtn": {
        readonly zh: "刷新";
        readonly en: "Refresh";
        readonly ja: "更新";
        readonly tok: "o lukin sin";
    };
    readonly "bl.refreshTitle": {
        readonly zh: "刷新贴图列表";
        readonly en: "Refresh texture list";
        readonly ja: "テクスチャ一覧を更新";
        readonly tok: "o lukin sin e nimi sitelen ale";
    };
    readonly "bl.pullTextureLabel": {
        readonly zh: "拉取贴图";
        readonly en: "Pull texture";
        readonly ja: "テクスチャを取得";
        readonly tok: "o kama jo e sitelen";
    };
    readonly "bl.pullSettingsTitle": {
        readonly zh: "拉取设置";
        readonly en: "Pull settings";
        readonly ja: "取得設定";
        readonly tok: "nasin pi kama jo";
    };
    readonly "bl.pullToTitle": {
        readonly zh: "拉到";
        readonly en: "Pull to";
        readonly ja: "取得先";
        readonly tok: "tawa";
    };
    readonly "bl.newLayerRadio": {
        readonly zh: "新建图层";
        readonly en: "Create new layer";
        readonly ja: "新規レイヤーを作成";
        readonly tok: "lipu sin";
    };
    readonly "bl.overwriteCurrentLayer": {
        readonly zh: "覆盖当前图层";
        readonly en: "Overwrite current layer";
        readonly ja: "現在のレイヤーを上書き";
        readonly tok: "lipu ni (insa pini li weka)";
    };
    readonly "bl.pushTextureLabel": {
        readonly zh: "推送贴图";
        readonly en: "Push texture";
        readonly ja: "テクスチャを送信";
        readonly tok: "o pana e sitelen";
    };
    readonly "bl.pushSettingsTitle": {
        readonly zh: "推送设置";
        readonly en: "Push settings";
        readonly ja: "送信設定";
        readonly tok: "nasin pana";
    };
    readonly "bl.pushSourceTitle": {
        readonly zh: "推送来源";
        readonly en: "Push source";
        readonly ja: "送信元";
        readonly tok: "tan";
    };
    readonly "bl.activeLayerOrGroup": {
        readonly zh: "当前图层 / 组";
        readonly en: "Current layer / group";
        readonly ja: "現在のレイヤー / グループ";
        readonly tok: "lipu ni / kulupu ni";
    };
    readonly "bl.buildRefAfterPush": {
        readonly zh: "推送后建/更新参考图";
        readonly en: "Create/update reference after push";
        readonly ja: "送信後に参考画像を作成/更新";
        readonly tok: "pana la sitelen lukin li kama sin";
    };
    readonly "bl.sizeLabel": {
        readonly zh: "尺寸（拉伸贴合，空 = doc 尺寸）";
        readonly en: "Size (stretch to fit, blank = doc size)";
        readonly ja: "サイズ（引き伸ばして合わせる、空欄 = doc サイズ）";
        readonly tok: "suli (ala = suli supa)";
    };
    readonly "bl.widthPlaceholder": {
        readonly zh: "宽";
        readonly en: "W";
        readonly ja: "幅";
        readonly tok: "poka";
    };
    readonly "bl.heightPlaceholder": {
        readonly zh: "高";
        readonly en: "H";
        readonly ja: "高さ";
        readonly tok: "sewi";
    };
    readonly "bl.sizePresetAria": {
        readonly zh: "尺寸预设";
        readonly en: "Size preset";
        readonly ja: "サイズプリセット";
        readonly tok: "suli open";
    };
    readonly "bl.presetPlaceholder": {
        readonly zh: "预设…";
        readonly en: "Preset…";
        readonly ja: "プリセット…";
        readonly tok: "suli open…";
    };
    readonly "bl.presetDocSize": {
        readonly zh: "原尺寸";
        readonly en: "Original size";
        readonly ja: "元のサイズ";
        readonly tok: "suli supa";
    };
    readonly "bl.presetFit512": {
        readonly zh: "比例 ≤512";
        readonly en: "Ratio ≤512";
        readonly ja: "比率 ≤512";
        readonly tok: "sama supa · ≤512";
    };
    readonly "bl.presetFit1024": {
        readonly zh: "比例 ≤1024";
        readonly en: "Ratio ≤1024";
        readonly ja: "比率 ≤1024";
        readonly tok: "sama supa · ≤1024";
    };
    readonly "bl.presetFit2048": {
        readonly zh: "比例 ≤2048";
        readonly en: "Ratio ≤2048";
        readonly ja: "比率 ≤2048";
        readonly tok: "sama supa · ≤2048";
    };
    readonly "bl.presetSquare256": {
        readonly zh: "方 256²";
        readonly en: "Square 256²";
        readonly ja: "正方 256²";
        readonly tok: "leko 256²";
    };
    readonly "bl.presetSquare512": {
        readonly zh: "方 512²";
        readonly en: "Square 512²";
        readonly ja: "正方 512²";
        readonly tok: "leko 512²";
    };
    readonly "bl.presetSquare1024": {
        readonly zh: "方 1024²";
        readonly en: "Square 1024²";
        readonly ja: "正方 1024²";
        readonly tok: "leko 1024²";
    };
    readonly "bl.presetSquare2048": {
        readonly zh: "方 2048²";
        readonly en: "Square 2048²";
        readonly ja: "正方 2048²";
        readonly tok: "leko 2048²";
    };
    readonly "gs.footUsage": {
        readonly zh: "作品占用：{size}（{count} 件）";
        readonly en: "Artwork usage: {size} ({count} items)";
        readonly ja: "作品の使用量：{size}（{count} 件）";
        readonly tok: "suli awen: {size} ({count} sitelen)";
    };
    readonly "gs.footUsageTitle": {
        readonly zh: "浏览器分配上限约 {size}；当前 {pct}% 已用（含 SW 缓存等）";
        readonly en: "Browser allocation cap ~{size}; {pct}% used now (incl. SW cache, etc.)";
        readonly ja: "ブラウザ割り当て上限は約 {size}；現在 {pct}% 使用中（SW キャッシュ等を含む）";
        readonly tok: "ilo lukin li pana e poki pi suli {size}. {pct}% li kepeken.";
    };
    readonly "gs.usedSuffix": {
        readonly zh: " · 已用 {pct}%";
        readonly en: " · {pct}% used";
        readonly ja: " · {pct}% 使用";
        readonly tok: " · {pct}% li kepeken";
    };
    readonly "gs.usageUnknown": {
        readonly zh: "占用：未知";
        readonly en: "Usage: unknown";
        readonly ja: "使用量：不明";
        readonly tok: "suli awen: mi sona ala";
    };
    readonly "gs.quotaCritical": {
        readonly zh: "本地存储 {pct}% 已满 — 立即去图库卸载不常用的作品";
        readonly en: "Local storage {pct}% full — go to the gallery now and offload works you rarely use";
        readonly ja: "ローカルストレージが {pct}% 使用済み — 今すぐギャラリーで使わない作品を退避してください";
        readonly tok: "poki pi ilo ni li kama ale ({pct}%)! o tawa tomo sitelen. o weka e sitelen pi kepeken ala tan ilo ni.";
    };
    readonly "gs.quotaWarn": {
        readonly zh: "本地存储 {pct}% 已用 — 建议在图库整理";
        readonly en: "Local storage {pct}% used — consider tidying up in the gallery";
        readonly ja: "ローカルストレージが {pct}% 使用済み — ギャラリーで整理することをおすすめします";
        readonly tok: "poki pi ilo ni li kama mute ({pct}%). o lukin e tomo sitelen.";
    };
    readonly "gs.lockLabel": {
        readonly zh: "锁定加密作品（忘掉密码）";
        readonly en: "Lock encrypted works (forget password)";
        readonly ja: "暗号化作品をロック（パスワードを破棄）";
        readonly tok: "o pini e sitelen len (mi weka e nimi len tan lawa mi)";
    };
    readonly "gs.unlockLabel": {
        readonly zh: "解锁加密作品…";
        readonly en: "Unlock encrypted works…";
        readonly ja: "暗号化作品のロック解除…";
        readonly tok: "o open e sitelen len…";
    };
    readonly "gs.locked": {
        readonly zh: "已锁定加密作品（密码已从内存清除）";
        readonly en: "Encrypted works locked (password cleared from memory)";
        readonly ja: "暗号化作品をロックしました（パスワードをメモリから消去）";
        readonly tok: "sitelen len li pini. nimi len li weka tan lawa mi.";
    };
    readonly "gs.unlocked": {
        readonly zh: "已解锁加密作品（密码只在内存，关页即忘）";
        readonly en: "Encrypted works unlocked (password stays in memory only, forgotten on page close)";
        readonly ja: "暗号化作品のロックを解除しました（パスワードはメモリのみ、ページを閉じると消去）";
        readonly tok: "sitelen len li open. nimi len li awen lon tenpo ni taso. sina pini e ilo la mi weka e ona.";
    };
    readonly "gs.unlockTitle": {
        readonly zh: "解锁加密作品";
        readonly en: "Unlock encrypted works";
        readonly ja: "暗号化作品のロック解除";
        readonly tok: "o open e sitelen len";
    };
    readonly "gs.unlockNoLocalMsg": {
        readonly zh: "本地暂无加密作品可验证——密码先收下，用到时自动验证";
        readonly en: "No local encrypted work to verify against — the password is saved for now and verified automatically when needed";
        readonly ja: "ローカルに検証できる暗号化作品がありません——パスワードは先に保存し、使用時に自動で検証します";
        readonly tok: "sitelen len li lon ala ilo ni la mi ken ala lukin e nimi len. mi awen e ona. mi lukin e ona lon tenpo kepeken.";
    };
    readonly "gs.pwRecorded": {
        readonly zh: "已记下密码（打开加密作品时验证）";
        readonly en: "Password recorded (verified when opening an encrypted work)";
        readonly ja: "パスワードを記録しました（暗号化作品を開くときに検証）";
        readonly tok: "mi awen e nimi len. mi lukin e ona lon tenpo pi open sitelen.";
    };
    readonly "gs.unlockVerifierMsg": {
        readonly zh: "输入图库密码（跟账号走）。忘记 = 内容永久找不回，没有后门";
        readonly en: "Enter the gallery password (tied to your account). If forgotten, content is unrecoverable — there is no backdoor";
        readonly ja: "ギャラリーのパスワードを入力（アカウントに紐づく）。忘れた場合、内容は復元できません";
        readonly tok: "o pana e nimi len pi tomo sitelen. ona li tawa jan pi poki sewi. sina weka e ona la sitelen len li moli. sina ken ala open e ona lon tenpo ale. nasin len ala li lon.";
    };
    readonly "gs.pwWrongRetry": {
        readonly zh: "密码不对，再试一次";
        readonly en: "Wrong password, try again";
        readonly ja: "パスワードが違います。もう一度";
        readonly tok: "nimi len li sama ala. o pali sin.";
    };
    readonly "gs.resetPwTitle": {
        readonly zh: "重置图库密码？";
        readonly en: "Reset gallery password?";
        readonly ja: "ギャラリーパスワードをリセット？";
        readonly tok: "sina wile ala wile open sin e nimi len?";
    };
    readonly "gs.resetPwMsg": {
        readonly zh: "重置后下次加密可设新密码；但已有加密作品仍是旧密码，无法用新密码解锁。确定重置？";
        readonly en: "After reset you can set a new password for future encryption; existing encrypted works keep the old password and cannot be unlocked with the new one. Reset?";
        readonly ja: "リセット後は新しいパスワードを設定できますが、既存の暗号化作品は旧パスワードのままです。リセットしますか？";
        readonly tok: "tenpo kama la sina len e sitelen sin la sina ken pana e nimi len sin. taso sitelen len pi tenpo pini li kepeken nimi len pini. nimi len sin li ken ala open e ona.";
    };
    readonly "gs.pwResetDone": {
        readonly zh: "已重置。下次加密时设置新密码";
        readonly en: "Reset done. Set a new password next time you encrypt";
        readonly ja: "リセットしました。次回の暗号化時に新パスワードを設定します";
        readonly tok: "open sin li pini. tenpo kama la sina len e sitelen la o pana e nimi len sin.";
    };
    readonly "gs.clipboardNoImage": {
        readonly zh: "剪贴板里没有图片";
        readonly en: "No image in the clipboard";
        readonly ja: "クリップボードに画像がありません";
        readonly tok: "sitelen li lon ala poki kipisi";
    };
    readonly "gs.clipboardNewFailed": {
        readonly zh: "从剪切板新建失败：{err}";
        readonly en: "Failed to create from clipboard: {err}";
        readonly ja: "クリップボードからの新規作成に失敗しました：{err}";
        readonly tok: "pali tan poki kipisi li pakala: {err}";
    };
    readonly "gs.untitled": {
        readonly zh: "未命名";
        readonly en: "Untitled";
        readonly ja: "名称未設定";
        readonly tok: "nimi ala";
    };
    readonly "gs.created": {
        readonly zh: "新建：{name}（{w}×{h}）";
        readonly en: "Created: {name} ({w}×{h})";
        readonly ja: "新規作成：{name}（{w}×{h}）";
        readonly tok: "sitelen sin li lon: {name} ({w}×{h})";
    };
    readonly "gs.folderNeedSignin": {
        readonly zh: "新建文件夹需先登录云端（空文件夹存在 OneDrive 上）";
        readonly en: "Creating a folder requires signing in to the cloud first (empty folders live on OneDrive)";
        readonly ja: "フォルダを作成するにはクラウドにサインインが必要です（空フォルダは OneDrive に保存されます）";
        readonly tok: "poki sin li wile e ni: poki sewi li sona e sina. poki pi jo ala li lon poki sewi taso.";
    };
    readonly "gs.newFolderTitle": {
        readonly zh: "新建文件夹";
        readonly en: "New folder";
        readonly ja: "新しいフォルダ";
        readonly tok: "poki sin";
    };
    readonly "gs.newFolderDefault": {
        readonly zh: "新文件夹";
        readonly en: "New folder";
        readonly ja: "新しいフォルダ";
        readonly tok: "poki sin";
    };
    readonly "gs.folderNamePlaceholder": {
        readonly zh: "文件夹名";
        readonly en: "Folder name";
        readonly ja: "フォルダ名";
        readonly tok: "nimi poki";
    };
    readonly "gs.folderNameEmpty": {
        readonly zh: "文件夹名不能空";
        readonly en: "Folder name cannot be empty";
        readonly ja: "フォルダ名を空にできません";
        readonly tok: "nimi poki li wile lon";
    };
    readonly "gs.folderNameNoSlash": {
        readonly zh: "文件夹名不能含 /（要建嵌套请进对应文件夹再点新建）";
        readonly en: "Folder name cannot contain / (to nest, enter the target folder first, then create)";
        readonly ja: "フォルダ名に / を含められません（入れ子を作るには対象フォルダに入ってから作成してください）";
        readonly tok: "sitelen \"/\" li ken ala lon nimi poki. sina wile e poki insa la o open e poki mama lon tenpo open.";
    };
    readonly "gs.creatingFolder": {
        readonly zh: "正在创建文件夹 {name}…";
        readonly en: "Creating folder {name}…";
        readonly ja: "フォルダ {name} を作成中…";
        readonly tok: "mi pali e poki {name}…";
    };
    readonly "gs.folderExists": {
        readonly zh: "文件夹 \"{name}\" 已存在";
        readonly en: "Folder \"{name}\" already exists";
        readonly ja: "フォルダ「{name}」は既に存在します";
        readonly tok: "poki \"{name}\" li lon";
    };
    readonly "gs.folderCreated": {
        readonly zh: "已建文件夹：{name}";
        readonly en: "Folder created: {name}";
        readonly ja: "フォルダを作成しました：{name}";
        readonly tok: "poki sin li lon: {name}";
    };
    readonly "gs.folderCreateFailed": {
        readonly zh: "建文件夹失败：{err}";
        readonly en: "Failed to create folder: {err}";
        readonly ja: "フォルダの作成に失敗しました：{err}";
        readonly tok: "pali poki li pakala: {err}";
    };
    readonly "cf.signedIn": {
        readonly zh: "已登录";
        readonly en: "Signed in";
        readonly ja: "ログイン済み";
        readonly tok: "poki sewi li sona e sina";
    };
    readonly "cf.signInFailed": {
        readonly zh: "登录失败：{err}";
        readonly en: "Sign-in failed: {err}";
        readonly ja: "ログイン失敗：{err}";
        readonly tok: "kama sona li pakala: {err}";
    };
    readonly "cf.checkingCloud": {
        readonly zh: "检查云端";
        readonly en: "Checking cloud";
        readonly ja: "クラウドを確認中";
        readonly tok: "mi lukin e poki sewi";
    };
    readonly "cf.skipToOffline": {
        readonly zh: "跳过到离线";
        readonly en: "Skip to offline";
        readonly ja: "スキップしてオフライン";
        readonly tok: "o open kepeken ilo ni taso";
    };
    readonly "cf.conflictBothChanged": {
        readonly zh: "「{name}」云端与本地都改过，保留哪份？";
        readonly en: "“{name}” was changed both in the cloud and locally. Which version do you want to keep?";
        readonly ja: "「{name}」はクラウドとローカルの両方で変更されています。どちらのバージョンを残しますか？";
        readonly tok: "sitelen \"{name}\" li ante lon poki sewi li ante lon ilo ni. sina wile awen e seme?";
    };
    readonly "cf.cloudNewerTitle": {
        readonly zh: "云端有新版本";
        readonly en: "A newer version exists in the cloud";
        readonly ja: "クラウドに新しいバージョンがあります";
        readonly tok: "sitelen sin li lon poki sewi";
    };
    readonly "cf.keepLocal": {
        readonly zh: "保留本地（之后 push 会再确认）";
        readonly en: "Keep local (will reconfirm on next push)";
        readonly ja: "ローカルを保持（後で push 時に再確認）";
        readonly tok: "o awen e sitelen pi ilo ni (pana kama la mi toki sin)";
    };
    readonly "cf.overwriteLocal": {
        readonly zh: "用云端覆盖本地（本地先备份进 .backup）";
        readonly en: "Overwrite local with cloud (local is backed up to .backup first)";
        readonly ja: "クラウドでローカルを上書き（ローカルは先に .backup へバックアップ）";
        readonly tok: "o kepeken e sitelen pi poki sewi (sitelen pi ilo ni li tawa poki awen \".backup\" lon tenpo open)";
    };
    readonly "cf.cloudAccountOfflineTitle": {
        readonly zh: "云端：{who}（离线，无法推 / 拉）";
        readonly en: "Cloud: {who} (offline, cannot push / pull)";
        readonly ja: "クラウド：{who}（オフライン、push / pull 不可）";
        readonly tok: "poki sewi: {who} (toki li ken ala. pana en kama li ken ala.)";
    };
    readonly "cf.cloudAccountTitle": {
        readonly zh: "云端：{who}（点开账号菜单）";
        readonly en: "Cloud: {who} (tap to open account menu)";
        readonly ja: "クラウド：{who}（アカウントメニューを開く）";
        readonly tok: "poki sewi: {who} (o luka la nasin jan li open)";
    };
    readonly "cf.cloudAccountOfflineInfo": {
        readonly zh: "云端：{who}（离线）";
        readonly en: "Cloud: {who} (offline)";
        readonly ja: "クラウド：{who}（オフライン）";
        readonly tok: "poki sewi: {who} (toki li ken ala)";
    };
    readonly "cf.cloudAccountInfo": {
        readonly zh: "云端：{who}";
        readonly en: "Cloud: {who}";
        readonly ja: "クラウド：{who}";
        readonly tok: "poki sewi: {who}";
    };
    readonly "cf.cloudOfflineTitle": {
        readonly zh: "云端：离线（无法登录 / 同步；本地图库正常）";
        readonly en: "Cloud: offline (cannot sign in / sync; local gallery works normally)";
        readonly ja: "クラウド：オフライン（ログイン / 同期不可；ローカルギャラリーは正常）";
        readonly tok: "poki sewi: toki li ken ala. kama sona en pana li ken ala. tomo sitelen pi ilo ni li pali pona.";
    };
    readonly "cf.cloudOffline": {
        readonly zh: "云端：离线";
        readonly en: "Cloud: offline";
        readonly ja: "クラウド：オフライン";
        readonly tok: "poki sewi: toki li ken ala";
    };
    readonly "cf.cloudNotSignedInTitle": {
        readonly zh: "云端：未登录（点开登录）";
        readonly en: "Cloud: not signed in (tap to sign in)";
        readonly ja: "クラウド：未ログイン（タップしてログイン）";
        readonly tok: "poki sewi li sona ala e sina (o luka)";
    };
    readonly "cf.cloudNotSignedIn": {
        readonly zh: "云端：未登录";
        readonly en: "Cloud: not signed in";
        readonly ja: "クラウド：未ログイン";
        readonly tok: "poki sewi li sona ala e sina";
    };
    readonly "cf.cloudNotConfigured": {
        readonly zh: "云端：未配置";
        readonly en: "Cloud: not configured";
        readonly ja: "クラウド：未設定";
        readonly tok: "poki sewi: nasin li lon ala";
    };
    readonly "cf.notConfiguredClient": {
        readonly zh: "尚未配置 OneDrive 客户端";
        readonly en: "OneDrive client not configured yet";
        readonly ja: "OneDrive クライアントが未設定です";
        readonly tok: "nasin pi ilo \"OneDrive\" li lon ala";
    };
    readonly "br.toolBrush": {
        readonly zh: "笔刷";
        readonly en: "Brush";
        readonly ja: "ブラシ";
        readonly tok: "ilo sitelen";
    };
    readonly "br.toolEraser": {
        readonly zh: "橡皮";
        readonly en: "Eraser";
        readonly ja: "消しゴム";
        readonly tok: "ilo weka";
    };
    readonly "br.rackTitle": {
        readonly zh: "笔架 · {tool}";
        readonly en: "Brush Rack · {tool}";
        readonly ja: "ブラシラック · {tool}";
        readonly tok: "poki pi ilo sitelen · {tool}";
    };
    readonly "br.saved": {
        readonly zh: "已保存：{name}";
        readonly en: "Saved: {name}";
        readonly ja: "保存しました：{name}";
        readonly tok: "awen li pini: {name}";
    };
    readonly "br.deleteBrushTitle": {
        readonly zh: "删除这支笔？";
        readonly en: "Delete this brush?";
        readonly ja: "このブラシを削除しますか？";
        readonly tok: "sina wile ala wile moli e ilo ni?";
    };
    readonly "br.deleteBrushMsg": {
        readonly zh: "「{name}」（不可撤销）";
        readonly en: "“{name}” (cannot be undone)";
        readonly ja: "「{name}」（取り消せません）";
        readonly tok: "\"{name}\" li moli. sina ken ala weka e pali ni.";
    };
    readonly "br.deleted": {
        readonly zh: "已删除";
        readonly en: "Deleted";
        readonly ja: "削除しました";
        readonly tok: "moli li pini";
    };
    readonly "br.rackRestored": {
        readonly zh: "已还原 {n} 支内置笔刷";
        readonly en: "Restored {n} built-in brushes";
        readonly ja: "内蔵ブラシ {n} 本を復元しました";
        readonly tok: "mi kama sin e ilo pi tan open ({n})";
    };
    readonly "br.rackRestoreFailed": {
        readonly zh: "内置笔刷数据没加载到，还原已取消（检查网络后重试）";
        readonly en: "Built-in brush data unavailable — restore cancelled (check your connection and retry).";
        readonly ja: "内蔵ブラシのデータを読み込めず、復元を中止しました（通信を確認して再試行）";
        readonly tok: "sona ilo pi tan open li kama ala. kama sin li weka. o lukin e ken toki. o pali sin.";
    };
    readonly "br.folderExported": {
        readonly zh: "已导出文件夹「{folder}」（{n} 笔）";
        readonly en: "Exported folder “{folder}” ({n} brushes)";
        readonly ja: "フォルダ「{folder}」をエクスポートしました（{n} 本）";
        readonly tok: "pana li pini: poki \"{folder}\" (ilo {n})";
    };
    readonly "br.folderEmpty": {
        readonly zh: "本文件夹是空的";
        readonly en: "This folder is empty";
        readonly ja: "このフォルダは空です";
        readonly tok: "poki ni li jo e ala";
    };
    readonly "br.refreshed": {
        readonly zh: "笔架已与云端同步";
        readonly en: "Brush rack synced with cloud";
        readonly ja: "ブラシラックをクラウドと同期しました";
        readonly tok: "poki pi ilo sitelen li sama poki sewi";
    };
    readonly "br.refreshFailed": {
        readonly zh: "笔架刷新未完成（{status}）";
        readonly en: "Brush rack refresh incomplete ({status})";
        readonly ja: "ブラシラックの更新が完了しませんでした（{status}）";
        readonly tok: "kama sama li pini ala ({status})";
    };
    readonly "br.refreshing": {
        readonly zh: "正在从云端刷新笔架…";
        readonly en: "Refreshing rack from cloud…";
        readonly ja: "クラウドからブラシラックを更新中…";
        readonly tok: "mi kama sama poki sewi…";
    };
    readonly "br.resetRackTitle": {
        readonly zh: "还原内置笔刷？";
        readonly en: "Restore built-in brushes?";
        readonly ja: "内蔵ブラシを復元しますか？";
        readonly tok: "sina wile ala wile kama sin e ilo pi tan open?";
    };
    readonly "br.resetRackMsg": {
        readonly zh: "把内置笔刷恢复成出厂设置，并排到各分组最前。你自己新建或导入的笔刷不会被删除。";
        readonly en: "Restores the built-in brushes to their factory settings and moves them to the top of each folder. Your own brushes are not deleted.";
        readonly ja: "内蔵ブラシを工場出荷時の設定に戻し、各フォルダーの先頭に並べ替えます。自作・読み込んだブラシは削除されません。";
        readonly tok: "ilo pi tan open li kama sama open. ona li tawa sewi poki. ilo pi pali sina li weka ala.";
    };
    readonly "br.codeExported": {
        readonly zh: "已导出 {n} 笔的代码文件";
        readonly en: "Exported code file for {n} brushes";
        readonly ja: "{n} 本のブラシのコードファイルをエクスポートしました";
        readonly tok: "pana li pini: lipu nasin (ilo {n})";
    };
    readonly "br.imported": {
        readonly zh: "已导入：{name}";
        readonly en: "Imported: {name}";
        readonly ja: "インポートしました：{name}";
        readonly tok: "kama jo li pini: {name}";
    };
    readonly "br.importFailed": {
        readonly zh: "导入失败：{error}";
        readonly en: "Import failed: {error}";
        readonly ja: "インポート失敗：{error}";
        readonly tok: "kama jo li pakala: {error}";
    };
    readonly "se.noSelection": {
        readonly zh: "没选区";
        readonly en: "No selection";
        readonly ja: "選択範囲がありません";
        readonly tok: "ma wile li lon ala";
    };
    readonly "se.maxLayersReached": {
        readonly zh: "图层数已达上限 {max}";
        readonly en: "Layer count reached the limit {max}";
        readonly ja: "レイヤー数が上限 {max} に達しました";
        readonly tok: "lipu li mute sewi ({max})";
    };
    readonly "se.selectLayerFirstGroup": {
        readonly zh: "请先选择一个图层（组不能这样操作）";
        readonly en: "Please select a layer first (groups can't do this)";
        readonly ja: "先にレイヤーを選択してください（グループはこの操作ができません）";
        readonly tok: "o wile e lipu lon tenpo open (kulupu li ken ala ni)";
    };
    readonly "se.movedToNewLayer": {
        readonly zh: "已移到新层";
        readonly en: "Moved to new layer";
        readonly ja: "新規レイヤーへ移動しました";
        readonly tok: "tawa lipu sin li pini";
    };
    readonly "se.copiedToNewLayer": {
        readonly zh: "已复制到新层";
        readonly en: "Copied to new layer";
        readonly ja: "新規レイヤーへ複製しました";
        readonly tok: "sama li lon lipu sin";
    };
    readonly "se.selectionOutsideLayer": {
        readonly zh: "选区在图层外，无内容可复制";
        readonly en: "Selection is outside the layer, nothing to copy";
        readonly ja: "選択範囲がレイヤーの外にあり、コピーできる内容がありません";
        readonly tok: "ma wile li lon selo lipu. mi ken jo e ala.";
    };
    readonly "se.layerEmpty": {
        readonly zh: "当前图层为空";
        readonly en: "Current layer is empty";
        readonly ja: "現在のレイヤーは空です";
        readonly tok: "lipu ni li jo e ala";
    };
    readonly "se.copiedSelectionToClipboard": {
        readonly zh: "已复制选区到剪贴板";
        readonly en: "Copied selection to clipboard";
        readonly ja: "選択範囲をクリップボードにコピーしました";
        readonly tok: "ma wile li tawa poki kipisi";
    };
    readonly "se.copiedLayerToClipboard": {
        readonly zh: "已复制当前图层到剪贴板";
        readonly en: "Copied current layer to clipboard";
        readonly ja: "現在のレイヤーをクリップボードにコピーしました";
        readonly tok: "lipu ni li tawa poki kipisi";
    };
    readonly "se.copyFailed": {
        readonly zh: "复制失败：{error}";
        readonly en: "Copy failed: {error}";
        readonly ja: "コピーに失敗しました：{error}";
        readonly tok: "pali sama li pakala: {error}";
    };
    readonly "se.clipboardReadFailed": {
        readonly zh: "读取剪贴板失败：{error}";
        readonly en: "Failed to read clipboard: {error}";
        readonly ja: "クリップボードの読み取りに失敗しました：{error}";
        readonly tok: "lukin pi poki kipisi li pakala: {error}";
    };
    readonly "se.clipboardNoImage": {
        readonly zh: "剪贴板里没有图片";
        readonly en: "No image in the clipboard";
        readonly ja: "クリップボードに画像がありません";
        readonly tok: "sitelen li lon ala poki kipisi";
    };
    readonly "se.selectBeforeDuplicateFloat": {
        readonly zh: "先框选再 Ctrl+D 复制为浮层";
        readonly en: "Make a selection first, then Ctrl+D to duplicate as a floating layer";
        readonly ja: "先に範囲を選択してから Ctrl+D でフローティングに複製してください";
        readonly tok: "o pali e ma wile lon tenpo open. o kepeken e nena Ctrl+D la lipu sewi li kama.";
    };
    readonly "se.duplicatedAsFloat": {
        readonly zh: "已复制选区为浮层（拖动定位 → 应用 / 取消）";
        readonly en: "Duplicated selection as a floating layer (drag to position → apply / cancel)";
        readonly ja: "選択範囲をフローティングに複製しました（ドラッグで配置 → 適用 / キャンセル）";
        readonly tok: "ma wile li kama lipu sewi (o tawa e ona → o pini / o weka)";
    };
    readonly "se.undoCreateLayer": {
        readonly zh: "已撤销创建图层「{name}」";
        readonly en: "Undid creating layer \"{name}\"";
        readonly ja: "レイヤー「{name}」の作成を取り消しました";
        readonly tok: "pali pi lipu \"{name}\" li weka";
    };
    readonly "se.restoredLayer": {
        readonly zh: "已恢复图层「{name}」";
        readonly en: "Restored layer \"{name}\"";
        readonly ja: "レイヤー「{name}」を復元しました";
        readonly tok: "lipu \"{name}\" li kama sin";
    };
    readonly "se.deletedLayer": {
        readonly zh: "已删除图层「{name}」";
        readonly en: "Deleted layer \"{name}\"";
        readonly ja: "レイヤー「{name}」を削除しました";
        readonly tok: "lipu \"{name}\" li weka";
    };
    readonly "se.undoMergeRestore": {
        readonly zh: "已撤销合并 · 恢复「{name}」";
        readonly en: "Undid merge · restored \"{name}\"";
        readonly ja: "結合を取り消し ·「{name}」を復元しました";
        readonly tok: "wan li weka · lipu \"{name}\" li kama sin";
    };
    readonly "se.mergedDown": {
        readonly zh: "已向下合并";
        readonly en: "Merged down";
        readonly ja: "下のレイヤーと結合しました";
        readonly tok: "wan anpa li pini";
    };
    readonly "se.layerMovedBack": {
        readonly zh: "图层「{name}」移回原位";
        readonly en: "Layer \"{name}\" moved back to its original position";
        readonly ja: "レイヤー「{name}」を元の位置に戻しました";
        readonly tok: "lipu \"{name}\" li kama sin lon ma ona";
    };
    readonly "se.layerMoved": {
        readonly zh: "图层「{name}」已移动";
        readonly en: "Layer \"{name}\" moved";
        readonly ja: "レイヤー「{name}」を移動しました";
        readonly tok: "lipu \"{name}\" li tawa";
    };
    readonly "se.layerNameRestored": {
        readonly zh: "图层名还原「{name}」";
        readonly en: "Layer name restored to \"{name}\"";
        readonly ja: "レイヤー名を「{name}」に戻しました";
        readonly tok: "nimi lipu li kama sin: \"{name}\"";
    };
    readonly "se.layerRenamed": {
        readonly zh: "图层重命名「{name}」";
        readonly en: "Layer renamed to \"{name}\"";
        readonly ja: "レイヤー名を「{name}」に変更しました";
        readonly tok: "nimi lipu li ante: \"{name}\"";
    };
    readonly "se.propVisible": {
        readonly zh: "可见";
        readonly en: "Visibility";
        readonly ja: "表示";
        readonly tok: "lukin";
    };
    readonly "se.propOpacity": {
        readonly zh: "不透明度";
        readonly en: "Opacity";
        readonly ja: "不透明度";
        readonly tok: "wawa kule";
    };
    readonly "se.propMode": {
        readonly zh: "混合";
        readonly en: "Blend";
        readonly ja: "ブレンド";
        readonly tok: "nasin pi wan anpa";
    };
    readonly "se.propClipping": {
        readonly zh: "剪裁";
        readonly en: "Clipping";
        readonly ja: "クリッピング";
        readonly tok: "insa anpa";
    };
    readonly "se.propLockAlpha": {
        readonly zh: "锁定不透明度";
        readonly en: "Lock opacity";
        readonly ja: "アルファロック";
        readonly tok: "ma sitelen taso";
    };
    readonly "se.propRestored": {
        readonly zh: "「{name}」{prop} 已还原";
        readonly en: "\"{name}\" {prop} restored";
        readonly ja: "「{name}」の{prop}を元に戻しました";
        readonly tok: "{prop} pi lipu \"{name}\" li kama sin";
    };
    readonly "se.propUpdated": {
        readonly zh: "「{name}」{prop} 已更新";
        readonly en: "\"{name}\" {prop} updated";
        readonly ja: "「{name}」の{prop}を更新しました";
        readonly tok: "{prop} pi lipu \"{name}\" li ante";
    };
    readonly "se.expandSelection": {
        readonly zh: "扩张选区";
        readonly en: "Expand selection";
        readonly ja: "選択範囲を拡張";
        readonly tok: "o suli e ma wile";
    };
    readonly "se.shrinkSelection": {
        readonly zh: "收缩选区";
        readonly en: "Shrink selection";
        readonly ja: "選択範囲を収縮";
        readonly tok: "o lili e ma wile";
    };
    readonly "se.selectionExpanded": {
        readonly zh: "选区已扩张";
        readonly en: "Selection expanded";
        readonly ja: "選択範囲を拡張しました";
        readonly tok: "ma wile li kama suli";
    };
    readonly "se.selectionShrunk": {
        readonly zh: "选区已收缩";
        readonly en: "Selection shrunk";
        readonly ja: "選択範囲を収縮しました";
        readonly tok: "ma wile li kama lili";
    };
    readonly "se.noPixelsToTransform": {
        readonly zh: "选区里没有可变换的像素，已取消选区";
        readonly en: "No transformable pixels in the selection; selection cleared";
        readonly ja: "選択範囲に変形できるピクセルがないため、選択を解除しました";
        readonly tok: "kule li lon ala ma wile la ante selo li ken ala. ma wile li weka.";
    };
    readonly "se.layerEmptyNoTransform": {
        readonly zh: "图层是空的，没东西可变换";
        readonly en: "The layer is empty, nothing to transform";
        readonly ja: "レイヤーが空で、変形するものがありません";
        readonly tok: "lipu li jo e ala la ante selo li ken ala";
    };
    readonly "se.hiddenNoTransform": {
        readonly zh: "当前图层已隐藏，不能变换";
        readonly en: "The current layer is hidden and cannot be transformed";
        readonly ja: "現在のレイヤーは非表示のため変形できません";
        readonly tok: "lipu ni li lukin ala la ante selo li ken ala";
    };
    readonly "se.filled": {
        readonly zh: "已填色：{color}";
        readonly en: "Filled: {color}";
        readonly ja: "塗りつぶしました：{color}";
        readonly tok: "kule li lon: {color}";
    };
    readonly "se.clearedSelection": {
        readonly zh: "已清除选区内像素";
        readonly en: "Cleared pixels within the selection";
        readonly ja: "選択範囲内のピクセルを消去しました";
        readonly tok: "kule lon ma wile li weka";
    };
    readonly "se.stamped": {
        readonly zh: "已盖印";
        readonly en: "Stamped";
        readonly ja: "スタンプしました";
        readonly tok: "mi jaki e lipu ni kepeken kule ale";
    };
    readonly "se.lassoFloatingBusy": {
        readonly zh: "套索浮层进行中，双击切换暂停（点应用 / 取消 / 返回工具栏）";
        readonly en: "Lasso floating in progress; double-tap switching paused (apply / cancel / back to toolbar)";
        readonly ja: "投げ縄フローティング中です。ダブルタップ切り替えは一時停止中（適用 / キャンセル / ツールバーに戻る）";
        readonly tok: "lipu sewi li open la ante ilo li lape (o pini / o weka / o kama sin tawa ilo)";
    };
    readonly "se.doubleTapEraser": {
        readonly zh: "双击 · 橡皮";
        readonly en: "Double-tap · Eraser";
        readonly ja: "ダブルタップ · 消しゴム";
        readonly tok: "luka pi tenpo tu · ilo weka";
    };
    readonly "se.doubleTapBrush": {
        readonly zh: "双击 · 笔刷";
        readonly en: "Double-tap · Brush";
        readonly ja: "ダブルタップ · ブラシ";
        readonly tok: "luka pi tenpo tu · ilo sitelen";
    };
    readonly "mi.defaultImportName": {
        readonly zh: "导入";
        readonly en: "Import";
        readonly ja: "インポート";
        readonly tok: "kama jo";
    };
    readonly "mi.defaultImageName": {
        readonly zh: "图像";
        readonly en: "Image";
        readonly ja: "画像";
        readonly tok: "sitelen";
    };
    readonly "mi.newFromPhoto": {
        readonly zh: "新建（照片）：{name}（{w}×{h}）";
        readonly en: "New (photo): {name} ({w}×{h})";
        readonly ja: "新規（写真）：{name}（{w}×{h}）";
        readonly tok: "sin tan sitelen: {name} ({w}×{h})";
    };
    readonly "mi.bigImportInfo": {
        readonly zh: "图片 {ow}×{oh} · 画布 {docW}×{docH}";
        readonly en: "Image {ow}×{oh} · Canvas {docW}×{docH}";
        readonly ja: "画像 {ow}×{oh} · キャンバス {docW}×{docH}";
        readonly tok: "sitelen {ow}×{oh} · supa {docW}×{docH}";
    };
    readonly "mi.layerLimitImport": {
        readonly zh: "图层已达上限 ({max})，无法导入";
        readonly en: "Layer limit reached ({max}); can't import";
        readonly ja: "レイヤー数が上限（{max}）に達したため、インポートできません";
        readonly tok: "lipu li mute sewi ({max}) la kama jo li ken ala";
    };
    readonly "mi.importedTransform": {
        readonly zh: "已导入：{name}（拖角变换 → 应用 / 取消）";
        readonly en: "Imported: {name} (drag corners to transform → apply / cancel)";
        readonly ja: "インポート済み：{name}（角をドラッグで変形 → 適用 / キャンセル）";
        readonly tok: "kama jo li pini: {name} (o luka e selo la ante → o pini / o weka)";
    };
    readonly "mi.importedAsLayer": {
        readonly zh: "已导入为新图层：{name}";
        readonly en: "Imported as new layer: {name}";
        readonly ja: "新規レイヤーとしてインポート：{name}";
        readonly tok: "kama jo tawa lipu sin li pini: {name}";
    };
    readonly "mi.importCancelledNeedPw": {
        readonly zh: "已取消导入（需要密码）";
        readonly en: "Import cancelled (password required)";
        readonly ja: "インポートをキャンセルしました（パスワードが必要）";
        readonly tok: "kama jo li weka (nimi len li wile)";
    };
    readonly "mi.imported": {
        readonly zh: "已导入：{name}";
        readonly en: "Imported: {name}";
        readonly ja: "インポート済み：{name}";
        readonly tok: "kama jo li pini: {name}";
    };
    readonly "mi.unsupportedFileType": {
        readonly zh: "不支持的文件类型：{type}";
        readonly en: "Unsupported file type: {type}";
        readonly ja: "対応していないファイル形式：{type}";
        readonly tok: "mi sona ala e nasin lipu ni: {type}";
    };
    readonly "mi.importFailed": {
        readonly zh: "导入失败：{err}";
        readonly en: "Import failed: {err}";
        readonly ja: "インポート失敗：{err}";
        readonly tok: "kama jo li pakala: {err}";
    };
    readonly "mi.exitGalleryBeforeDrop": {
        readonly zh: "退出图库后再拖入图片";
        readonly en: "Exit the gallery before dropping in an image";
        readonly ja: "ギャラリーを閉じてから画像をドロップしてください";
        readonly tok: "o pini e tomo sitelen lon tenpo open la sina ken pana e sitelen";
    };
    readonly "mi.dropFailed": {
        readonly zh: "拖入失败：{err}";
        readonly en: "Drop failed: {err}";
        readonly ja: "ドロップ失敗：{err}";
        readonly tok: "pana li pakala: {err}";
    };
    readonly "mi.unknownFilter": {
        readonly zh: "未知 filter：{id}";
        readonly en: "Unknown filter: {id}";
        readonly ja: "不明なフィルター：{id}";
        readonly tok: "mi sona ala e ilo ni: {id}";
    };
    readonly "mi.activeLayerEmpty": {
        readonly zh: "活动图层是空的";
        readonly en: "The active layer is empty";
        readonly ja: "アクティブなレイヤーが空です";
        readonly tok: "lipu ni li jo e ala";
    };
    readonly "mi.artFilters": {
        readonly zh: "艺术滤镜";
        readonly en: "Art filters";
        readonly ja: "アートフィルター";
        readonly tok: "ante musi";
    };
    readonly "mi.chooseFilter": {
        readonly zh: "选滤镜";
        readonly en: "Choose filter";
        readonly ja: "フィルターを選択";
        readonly tok: "o wile e ante";
    };
    readonly "mi.filterApplied": {
        readonly zh: "{title} 已应用：{name}";
        readonly en: "{title} applied: {name}";
        readonly ja: "{title} を適用しました：{name}";
        readonly tok: "{title} li pini: {name}";
    };
    readonly "mi.noArtFilters": {
        readonly zh: "没有艺术滤镜";
        readonly en: "No art filters";
        readonly ja: "アートフィルターがありません";
        readonly tok: "ante musi li lon ala";
    };
    readonly "mi.filterBrushMode": {
        readonly zh: "{title}（笔刷）";
        readonly en: "{title} (brush)";
        readonly ja: "{title}（ブラシ）";
        readonly tok: "{title} (ilo sitelen)";
    };
    readonly "mi.exitedFilterBrush": {
        readonly zh: "已退出 filter brush";
        readonly en: "Exited filter brush";
        readonly ja: "フィルターブラシを終了しました";
        readonly tok: "ilo sitelen pi ante kule li pini";
    };
    readonly "mi.switchedTo": {
        readonly zh: "已切 {title}";
        readonly en: "Switched to {title}";
        readonly ja: "{title} に切り替えました";
        readonly tok: "ilo li kama: {title}";
    };
    readonly "mi.boundaryTooltip": {
        readonly zh: "选区边界：位移源落到选区外怎么办";
        readonly en: "Selection boundary: what to do when the displacement source falls outside the selection";
        readonly ja: "選択範囲の境界：変位元が選択範囲外に出た場合の扱い";
        readonly tok: "selo pi ma wile: ijo li tan selo la mi kepeken e nasin seme?";
    };
    readonly "mi.boundary": {
        readonly zh: "边界：{mode}";
        readonly en: "Boundary: {mode}";
        readonly ja: "境界：{mode}";
        readonly tok: "selo: {mode}";
    };
    readonly "mi.referenceLoaded": {
        readonly zh: "参考：{name}{scaled}（会跟当前画一起保存）";
        readonly en: "Reference: {name}{scaled} (saved together with the current artwork)";
        readonly ja: "参考：{name}{scaled}（現在の作品と一緒に保存されます）";
        readonly tok: "sitelen lukin: {name}{scaled} (mi awen e ona lon insa pi sitelen ni)";
    };
    readonly "mi.referenceScaled": {
        readonly zh: "（已缩到 {w}×{h}）";
        readonly en: " (scaled to {w}×{h})";
        readonly ja: "（{w}×{h} に縮小）";
        readonly tok: " (lili tawa {w}×{h})";
    };
    readonly "mi.referenceLoadFailed": {
        readonly zh: "参考图载入失败：{err}";
        readonly en: "Failed to load reference image: {err}";
        readonly ja: "参考画像の読み込みに失敗：{err}";
        readonly tok: "sitelen lukin li ken ala kama: {err}";
    };
    readonly "mi.referenceLive": {
        readonly zh: "参考小窗：实时镜像主画布";
        readonly en: "Reference window: live-mirroring the main canvas";
        readonly ja: "参考ウィンドウ：メインキャンバスをリアルタイムミラー";
        readonly tok: "lupa lukin: sama supa sitelen lon tenpo ale";
    };
    readonly "mi.referenceLiveExit": {
        readonly zh: "参考小窗：已退出实时模式";
        readonly en: "Reference window: exited live mode";
        readonly ja: "参考ウィンドウ：リアルタイムモードを終了";
        readonly tok: "lupa lukin: nasin pi tenpo ale li pini";
    };
    readonly "mi.rackPersistFailed": {
        readonly zh: "笔架持久化失败（可能私密浏览）：本次 session 可用，重启会重置";
        readonly en: "Brush rack persistence failed (private browsing?): usable this session, resets on restart";
        readonly ja: "ブラシラックの保存に失敗（プライベートブラウズの可能性）：今回のセッションは使えますが、再起動でリセットされます";
        readonly tok: "poki pi ilo sitelen li ken ala awen (ken la ilo lukin li lon nasin len). tenpo ni la ona li pali. taso open sin la ona li kama sama open.";
    };
    readonly "mi.lastNotFound": {
        readonly zh: "找不到上次画作 \"{name}\"，先选一个或新建";
        readonly en: "Last artwork \"{name}\" not found; pick one or create a new one";
        readonly ja: "前回の作品「{name}」が見つかりません。選ぶか新規作成してください";
        readonly tok: "sitelen pini \"{name}\" li lon ala. o wile e sitelen ante (anu: o pali e sin).";
    };
    readonly "mi.enterPassword": {
        readonly zh: "输入密码";
        readonly en: "Enter password";
        readonly ja: "パスワードを入力";
        readonly tok: "o pana e nimi len";
    };
    readonly "mi.galleryPassword": {
        readonly zh: "图库密码";
        readonly en: "Gallery password";
        readonly ja: "ギャラリーのパスワード";
        readonly tok: "nimi len pi tomo sitelen";
    };
    readonly "flt.hsb.title": {
        readonly zh: "色相 / 饱和度 / 亮度";
        readonly en: "Hue / Saturation / Brightness";
        readonly ja: "色相 / 彩度 / 明度";
    };
    readonly "flt.hsb.brightness": {
        readonly zh: "亮度";
        readonly en: "Brightness";
        readonly ja: "明度";
    };
    readonly "flt.hsb.contrast": {
        readonly zh: "对比";
        readonly en: "Contrast";
        readonly ja: "コントラスト";
    };
    readonly "flt.hsb.saturation": {
        readonly zh: "饱和";
        readonly en: "Saturation";
        readonly ja: "彩度";
    };
    readonly "flt.hsb.satMode": {
        readonly zh: "模式";
        readonly en: "Mode";
        readonly ja: "モード";
    };
    readonly "flt.hsb.satNatural": {
        readonly zh: "自然";
        readonly en: "Vibrance";
        readonly ja: "自然な彩度";
    };
    readonly "flt.hsb.satLinear": {
        readonly zh: "线性";
        readonly en: "Linear";
        readonly ja: "リニア";
    };
    readonly "flt.hsb.hue": {
        readonly zh: "色相";
        readonly en: "Hue";
        readonly ja: "色相";
    };
    readonly "flt.cb.title": {
        readonly zh: "色彩平衡";
        readonly en: "Color balance";
        readonly ja: "カラーバランス";
    };
    readonly "flt.cb.cyanRed": {
        readonly zh: "青 ⟷ 红";
        readonly en: "C ⟷ R";
        readonly ja: "C ⟷ R";
    };
    readonly "flt.cb.magentaGreen": {
        readonly zh: "品 ⟷ 绿";
        readonly en: "M ⟷ G";
        readonly ja: "M ⟷ G";
    };
    readonly "flt.cb.yellowBlue": {
        readonly zh: "黄 ⟷ 蓝";
        readonly en: "Y ⟷ B";
        readonly ja: "Y ⟷ B";
    };
    readonly "flt.cb.shadows": {
        readonly zh: "阴影";
        readonly en: "Shadows";
        readonly ja: "シャドウ";
    };
    readonly "flt.cb.midtones": {
        readonly zh: "中间调";
        readonly en: "Midtones";
        readonly ja: "中間調";
    };
    readonly "flt.cb.highlights": {
        readonly zh: "高光";
        readonly en: "Highlights";
        readonly ja: "ハイライト";
    };
    readonly "flt.curves.title": {
        readonly zh: "曲线";
        readonly en: "Curves";
        readonly ja: "トーンカーブ";
    };
    readonly "flt.curves.all": {
        readonly zh: "全部";
        readonly en: "All";
        readonly ja: "すべて";
    };
    readonly "flt.liq.title": {
        readonly zh: "液化";
        readonly en: "Liquify";
        readonly ja: "ゆがみ";
    };
    readonly "flt.liq.push": {
        readonly zh: "推";
        readonly en: "Push";
        readonly ja: "押す";
    };
    readonly "flt.liq.pinch": {
        readonly zh: "收";
        readonly en: "Pinch";
        readonly ja: "つまむ";
    };
    readonly "flt.liq.bloat": {
        readonly zh: "胀";
        readonly en: "Bloat";
        readonly ja: "膨張";
    };
    readonly "flt.liq.twirlL": {
        readonly zh: "左旋";
        readonly en: "Twirl left";
        readonly ja: "左回転";
    };
    readonly "flt.liq.twirlR": {
        readonly zh: "右旋";
        readonly en: "Twirl right";
        readonly ja: "右回転";
    };
    readonly "flt.liq.bleedEdge": {
        readonly zh: "边缘拉伸";
        readonly en: "Stretch edge";
        readonly ja: "境界を伸ばす";
    };
    readonly "flt.liq.bleedClip": {
        readonly zh: "不拉边界外";
        readonly en: "Wall at boundary";
        readonly ja: "境界の外を使わない";
    };
    readonly "flt.liq.bleedImport": {
        readonly zh: "拉边界外";
        readonly en: "Pull from outside";
        readonly ja: "境界の外から引き込む";
    };
    readonly "flt.sb.title": {
        readonly zh: "锐化 / 模糊";
        readonly en: "Sharpen / Blur";
        readonly ja: "シャープ / ぼかし";
    };
    readonly "flt.sb.blurBrush": {
        readonly zh: "模糊（笔刷）";
        readonly en: "Blur (brush)";
        readonly ja: "ぼかし（ブラシ）";
    };
    readonly "flt.sb.sharpBrush": {
        readonly zh: "锐化（笔刷）";
        readonly en: "Sharpen (brush)";
        readonly ja: "シャープ（ブラシ）";
    };
    readonly "flt.sb.slider": {
        readonly zh: "模糊 ⟷ 锐化";
        readonly en: "Blur⟷Sharp";
        readonly ja: "ボケ ⟷ 鮮鋭";
    };
    readonly "flt.mos.title": {
        readonly zh: "马赛克";
        readonly en: "Mosaic";
        readonly ja: "モザイク";
    };
    readonly "flt.mos.cellSize": {
        readonly zh: "块大小";
        readonly en: "Cell size";
        readonly ja: "サイズ";
    };
    readonly "flt.ht.title": {
        readonly zh: "半调网点";
        readonly en: "Halftone";
        readonly ja: "ハーフトーン";
    };
    readonly "flt.ht.cellSize": {
        readonly zh: "间距";
        readonly en: "Pitch";
        readonly ja: "間隔";
    };
    readonly "flt.ht.dotScale": {
        readonly zh: "缩放";
        readonly en: "Scale";
        readonly ja: "スケール";
    };
    readonly "flt.ht.mode": {
        readonly zh: "模式";
        readonly en: "Mode";
        readonly ja: "モード";
    };
    readonly "flt.ht.blackOnWhite": {
        readonly zh: "黑点 on 白";
        readonly en: "Black on white";
        readonly ja: "白地に黒";
    };
    readonly "flt.ht.whiteOnBlack": {
        readonly zh: "白点 on 黑";
        readonly en: "White on black";
        readonly ja: "黒地に白";
    };
    readonly "flt.sg.title": {
        readonly zh: "教堂彩窗";
        readonly en: "Stained glass";
        readonly ja: "ステンドグラス";
    };
    readonly "flt.sg.cellSize": {
        readonly zh: "块大小";
        readonly en: "Cell size";
        readonly ja: "サイズ";
    };
    readonly "flt.sg.leadWidth": {
        readonly zh: "铅条粗细";
        readonly en: "Lead width";
        readonly ja: "鉛線の太さ";
    };
    readonly "rsm.bicubic": {
        readonly zh: "双三次（高质量）";
        readonly en: "Bicubic (high quality)";
        readonly ja: "バイキュービック（高品質）";
    };
    readonly "rsm.rotsprite": {
        readonly zh: "像素完美（像素画）";
        readonly en: "Pixel-perfect (pixel art)";
        readonly ja: "ピクセルパーフェクト（ドット絵）";
    };
    readonly "rsm.spline": {
        readonly zh: "样条（多次变换）";
        readonly en: "Spline (repeated transforms)";
        readonly ja: "スプライン（多重変形）";
    };
    readonly "rsm.sharper": {
        readonly zh: "缩小优化（清晰）";
        readonly en: "Downscale-optimized (crisp)";
        readonly ja: "縮小最適化（くっきり）";
    };
    readonly "rsm.bilinear": {
        readonly zh: "双线性（软）";
        readonly en: "Bilinear (soft)";
        readonly ja: "バイリニア（ソフト）";
    };
    readonly "rsm.nearest": {
        readonly zh: "最近邻（像素画）";
        readonly en: "Nearest (pixel art)";
        readonly ja: "ニアレスト（ドット絵）";
    };
    readonly "gv.badge.ghost": {
        readonly zh: "云端副本已被移动或删除，本地有未推送的修改 —— 可「重命名留存」或「丢弃」";
        readonly en: "Cloud copy was moved or deleted while local has unpushed edits — “rename & keep” or “discard”";
        readonly ja: "クラウド側が移動/削除され、ローカルに未プッシュの変更があります——「改名して保持」か「破棄」を";
    };
    readonly "gv.badge.pendingGone": {
        readonly zh: "云端副本已消失，本地干净副本待处理 —— 可「重新上传」推回云端，或「删除」；宽限期后自动移入回收站";
        readonly en: "Cloud copy is gone; clean local copy pending — “re-upload” to push it back, or “delete”; auto-trashed after the grace period";
        readonly ja: "クラウド側が消失、ローカルのクリーンな複製が保留中——「再アップロード」か「削除」を。猶予期間後は自動でゴミ箱へ";
    };
    readonly "gv.badge.dirtyBoth": {
        readonly zh: "本地+云端 · 本地有未推改动";
        readonly en: "Local+cloud · unpushed local edits";
        readonly ja: "ローカル+クラウド · 未プッシュの変更あり";
    };
    readonly "gv.badge.syncedBoth": {
        readonly zh: "本地+云端（已同步）";
        readonly en: "Local+cloud (synced)";
        readonly ja: "ローカル+クラウド（同期済み）";
    };
    readonly "gv.badge.cloudOnly": {
        readonly zh: "纯云端（未拉到本地）";
        readonly en: "Cloud only (not downloaded)";
        readonly ja: "クラウドのみ（未ダウンロード）";
    };
    readonly "gv.badge.localOnly": {
        readonly zh: "仅本地（未上传云端）";
        readonly en: "Local only (not uploaded)";
        readonly ja: "ローカルのみ（未アップロード）";
    };
    readonly "gv.badge.localPlain": {
        readonly zh: "本地";
        readonly en: "Local";
        readonly ja: "ローカル";
    };
    readonly "gv.rootDir": {
        readonly zh: "/ 根目录";
        readonly en: "/ Root";
        readonly ja: "/ ルート";
    };
    readonly "gv.time.unknown": {
        readonly zh: "未知";
        readonly en: "Unknown";
        readonly ja: "不明";
    };
    readonly "gv.time.justNow": {
        readonly zh: "刚刚";
        readonly en: "Just now";
        readonly ja: "たった今";
    };
    readonly "gv.time.minAgo": {
        readonly zh: "{n} 分钟前";
        readonly en: "{n} min ago";
        readonly ja: "{n} 分前";
    };
    readonly "gv.time.hourAgo": {
        readonly zh: "{n} 小时前";
        readonly en: "{n} h ago";
        readonly ja: "{n} 時間前";
    };
    readonly "gv.time.dayAgo": {
        readonly zh: "{n} 天前";
        readonly en: "{n} d ago";
        readonly ja: "{n} 日前";
    };
    readonly "gv.src.both": {
        readonly zh: "本地+云端";
        readonly en: "Local+cloud";
        readonly ja: "ローカル+クラウド";
    };
    readonly "gv.src.local": {
        readonly zh: "本地";
        readonly en: "Local";
        readonly ja: "ローカル";
    };
    readonly "gv.src.cloud": {
        readonly zh: "云端";
        readonly en: "Cloud";
        readonly ja: "クラウド";
    };
    readonly "gv.src.cloudStillAlive": {
        readonly zh: "{base}（云端仍在）";
        readonly en: "{base} (still in cloud)";
        readonly ja: "{base}（クラウドに残存）";
    };
    readonly "gs.usageCalculating": {
        readonly zh: "本地占用：计算中…";
        readonly en: "Local usage: calculating…";
        readonly ja: "ローカル使用量：計算中…";
    };
    readonly "name.copySuffix": {
        readonly zh: "副本";
        readonly en: "copy";
        readonly ja: "コピー";
    };
    readonly "name.newBrushN": {
        readonly zh: "新笔 {n}";
        readonly en: "New brush {n}";
        readonly ja: "新規ブラシ {n}";
    };
    readonly "name.brushBase": {
        readonly zh: "新笔";
        readonly en: "New brush";
        readonly ja: "新規ブラシ";
    };
    readonly "name.defaultBrush": {
        readonly zh: "默认笔";
        readonly en: "Default brush";
        readonly ja: "デフォルトブラシ";
    };
    readonly "name.groupN": {
        readonly zh: "组 {n}";
        readonly en: "Group {n}";
        readonly ja: "グループ {n}";
    };
    readonly "name.moveToNewLayer": {
        readonly zh: "移到新层";
        readonly en: "Moved to new layer";
        readonly ja: "新規レイヤーへ移動";
    };
    readonly "name.copyLayer": {
        readonly zh: "复制层";
        readonly en: "Copied layer";
        readonly ja: "コピーレイヤー";
    };
    readonly "st.groupNoDraw": {
        readonly zh: "当前选中的是图层组，请选择一个图层再绘制";
        readonly en: "A layer group is selected — pick a layer to draw";
        readonly ja: "グループが選択されています。描くにはレイヤーを選んでください";
    };
    readonly "st.hiddenNoDraw": {
        readonly zh: "当前图层已隐藏，无法绘制";
        readonly en: "The current layer is hidden — cannot draw";
        readonly ja: "現在のレイヤーは非表示のため描けません";
    };
    readonly "st.pickerHold": {
        readonly zh: "吸色（长按）";
        readonly en: "Eyedropper (long-press)";
        readonly ja: "スポイト（長押し）";
    };
    readonly "st.picked": {
        readonly zh: "吸色 {hex}";
        readonly en: "Picked {hex}";
        readonly ja: "スポイト {hex}";
    };
    readonly "st.twoFingerUndo": {
        readonly zh: "双指 · 撤销";
        readonly en: "Two fingers · Undo";
        readonly ja: "2本指 · 元に戻す";
    };
    readonly "st.threeFingerRedo": {
        readonly zh: "三指 · 重做";
        readonly en: "Three fingers · Redo";
        readonly ja: "3本指 · やり直す";
    };
    readonly "st.magicWandErr": {
        readonly zh: "魔术棒出错：{msg}";
        readonly en: "Magic wand error: {msg}";
        readonly ja: "自動選択エラー：{msg}";
    };
    readonly "st.selOpErr": {
        readonly zh: "选区操作出错：{msg}";
        readonly en: "Selection op error: {msg}";
        readonly ja: "選択操作エラー：{msg}";
    };
    readonly "st.filterBrushErr": {
        readonly zh: "filter brush 出错：{msg}";
        readonly en: "Filter brush error: {msg}";
        readonly ja: "フィルターブラシエラー：{msg}";
    };
    readonly "st.selPenNeedLayer": {
        readonly zh: "请先选中一个图层（选区笔预览需要锚点）";
        readonly en: "Select a layer first (the selection pen preview needs an anchor)";
        readonly ja: "先にレイヤーを選んでください（選択ペンのプレビューに必要）";
    };
    readonly "st.selAllOutside": {
        readonly zh: "选区全在画布外，已取消";
        readonly en: "Selection is entirely outside the canvas — cancelled";
        readonly ja: "選択範囲が全てキャンバス外のため取り消しました";
    };
    readonly "st.magicWandMiss": {
        readonly zh: "魔术棒：tap 在线 / 边界上，没选到";
        readonly en: "Magic wand: tapped on a line/border — nothing selected";
        readonly ja: "自動選択：線・境界上のため選択できません";
    };
    readonly "st.selCancelled": {
        readonly zh: "已取消选区";
        readonly en: "Selection cancelled";
        readonly ja: "選択を解除しました";
    };
    readonly "st.polyInvalid": {
        readonly zh: "多边形选区无效（不足三点 / 全在画布外），已取消";
        readonly en: "Polygon selection invalid (fewer than 3 points / all outside) — cancelled";
        readonly ja: "多角形選択が無効（3点未満 / 全て外側）のため取り消しました";
    };
    readonly "el.none": {
        readonly zh: "没有活动图层";
        readonly en: "No active layer";
        readonly ja: "アクティブレイヤーがありません";
    };
    readonly "el.group": {
        readonly zh: "当前选中的是图层组，请选择一个图层";
        readonly en: "A layer group is selected — pick a layer";
        readonly ja: "グループが選択されています。レイヤーを選んでください";
    };
    readonly "el.hidden": {
        readonly zh: "当前图层已隐藏";
        readonly en: "The current layer is hidden";
        readonly ja: "現在のレイヤーは非表示です";
    };
    readonly "enc.unlockTitle": {
        readonly zh: "解锁加密作品";
        readonly en: "Unlock encrypted artwork";
        readonly ja: "暗号化作品のロック解除";
    };
    readonly "enc.wrongRetry": {
        readonly zh: "密码不对，再试一次";
        readonly en: "Wrong password — try again";
        readonly ja: "パスワードが違います。もう一度";
    };
    readonly "enc.enterGalleryPw": {
        readonly zh: "输入图库密码。密码只存在内存里，关页即忘。";
        readonly en: "Enter the gallery password. It lives only in memory and is forgotten when the page closes.";
        readonly ja: "ギャラリーのパスワードを入力。メモリにのみ保持され、ページを閉じると消えます。";
    };
    readonly "enc.unlockImportTitle": {
        readonly zh: "解锁导入的加密文件";
        readonly en: "Unlock imported encrypted file";
        readonly ja: "インポートした暗号化ファイルのロック解除";
    };
    readonly "enc.importPrompt": {
        readonly zh: "这是加密文件。输入它的密码。";
        readonly en: "This file is encrypted. Enter its password.";
        readonly ja: "これは暗号化ファイルです。パスワードを入力してください。";
    };
    readonly "enc.enterPwTitle": {
        readonly zh: "输入图库密码";
        readonly en: "Enter gallery password";
        readonly ja: "ギャラリーパスワードを入力";
    };
    readonly "enc.enterPwMsg": {
        readonly zh: "图库已设过密码（跟账号走）。输入原密码；忘记 = 内容永久找不回。";
        readonly en: "This gallery already has a password (tied to your account). Enter it — if forgotten, the content is permanently unrecoverable.";
        readonly ja: "ギャラリーには既にパスワードが設定されています（アカウントに紐付き）。忘れた場合、内容は永久に復元できません。";
    };
    readonly "enc.setPwTitle": {
        readonly zh: "设置图库密码";
        readonly en: "Set gallery password";
        readonly ja: "ギャラリーパスワードを設定";
    };
    readonly "enc.setPwMismatch": {
        readonly zh: "两次输入不一致，重新设置";
        readonly en: "Entries don't match — try again";
        readonly ja: "入力が一致しません。やり直してください";
    };
    readonly "enc.setPwMsg": {
        readonly zh: "整个图库共用这一个密码。忘记 = 内容永久找不回（没有任何后门）；太短的密码可被暴力破解。加密文件用 7-Zip 输此密码也能打开。";
        readonly en: "One password for the whole gallery. If forgotten, content is permanently unrecoverable (there is no backdoor); short passwords can be brute-forced. Encrypted files also open in 7-Zip with this password.";
        readonly ja: "ギャラリー全体で1つのパスワードを共有します。忘れると内容は永久に復元できません（バックドアなし）。短いパスワードは総当たりに弱いです。暗号化ファイルは 7-Zip でも同じパスワードで開けます。";
    };
    readonly "enc.confirmTitle": {
        readonly zh: "再输一遍确认";
        readonly en: "Confirm password";
        readonly ja: "もう一度入力して確認";
    };
    readonly "enc.confirmMsg": {
        readonly zh: "两次输入需一致";
        readonly en: "Both entries must match";
        readonly ja: "同じものを入力してください";
    };
    readonly "exp.oraLabel": {
        readonly zh: ".ora（推荐 / 开源）";
        readonly en: ".ora (recommended / open format)";
        readonly ja: ".ora（推奨 / オープン形式）";
    };
    readonly "exp.psdBusy": {
        readonly zh: "PSD 编码中…";
        readonly en: "Encoding PSD…";
        readonly ja: "PSD エンコード中…";
    };
    readonly "print.title": {
        readonly zh: "打印";
        readonly en: "Print";
        readonly ja: "印刷";
    };
    readonly "err.unknown": {
        readonly zh: "未知错误";
        readonly en: "Unknown error";
        readonly ja: "不明なエラー";
    };
    readonly "err.dismissHint": {
        readonly zh: "点击关闭";
        readonly en: "tap to dismiss";
        readonly ja: "タップで閉じる";
    };
    readonly "busy.working": {
        readonly zh: "处理中…";
        readonly en: "Working…";
        readonly ja: "処理中…";
    };
    readonly "board.noWebgl2a": {
        readonly zh: "此设备不支持 WebGL2 —— 无法运行画布";
        readonly en: "This device has no WebGL2 — the canvas cannot run";
        readonly ja: "この端末は WebGL2 非対応のためキャンバスを実行できません";
    };
    readonly "board.noWebgl2b": {
        readonly zh: "请用支持 WebGL2 的浏览器/设备打开";
        readonly en: "Please open in a WebGL2-capable browser/device";
        readonly ja: "WebGL2 対応のブラウザ/端末で開いてください";
    };
    readonly "rack.shareTitle": {
        readonly zh: "笔架代码";
        readonly en: "Brush rack data";
        readonly ja: "ブラシ棚データ";
    };
    readonly "pal.brush": {
        readonly zh: "刷（用当前色）";
        readonly en: "Paint (with current color)";
        readonly ja: "塗る（現在の色）";
    };
    readonly "pal.mix": {
        readonly zh: "混色";
        readonly en: "Mix";
        readonly ja: "混色";
    };
    readonly "pal.pick": {
        readonly zh: "吸到主画";
        readonly en: "Pick to main canvas";
        readonly ja: "メインへスポイト";
    };
    readonly "pal.clear": {
        readonly zh: "清空";
        readonly en: "Clear";
        readonly ja: "クリア";
    };
    readonly "la.transformMove": {
        readonly zh: "变换 / 移动";
        readonly en: "Transform / Move";
        readonly ja: "変形 / 移動";
    };
    readonly "la.tfFree": {
        readonly zh: "自由变换";
        readonly en: "Free transform";
        readonly ja: "自由変形";
    };
    readonly "la.tfUniform": {
        readonly zh: "等比缩放";
        readonly en: "Uniform scale";
        readonly ja: "等倍スケール";
    };
    readonly "la.tfDistort": {
        readonly zh: "透视变换";
        readonly en: "Perspective transform";
        readonly ja: "遠近変形";
    };
    readonly "la.stampTip": {
        readonly zh: "盖印（写入但保留浮层，可连击多次叠加）";
        readonly en: "Stamp (writes but keeps the floating layer; tap repeatedly to stack)";
        readonly ja: "スタンプ（書き込み後もフロートを保持、連打で重ねられます）";
    };
    readonly "crop.widthPh": {
        readonly zh: "宽px";
        readonly en: "W px";
        readonly ja: "幅px";
    };
    readonly "crop.heightPh": {
        readonly zh: "高px";
        readonly en: "H px";
        readonly ja: "高px";
    };
};
