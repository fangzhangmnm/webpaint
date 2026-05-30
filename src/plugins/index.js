// 第一方调色 / 调整插件 barrel
// app.js 一次 import 这里就完成所有 built-in filter 注册。
//
// 加新内建插件：在下面 import 一行即可。
// 第三方下载插件（mosaic、halftone、stained glass、教堂彩窗 等）后期走
// fetch + dynamic import + window.WebPaint.registerFilter(...)，
// 不需要 ship 时打包进 bundle。论证：docs/backlog.md AI 插件 / artist filter 段

// 调色组（category="adjustment"）
import "./hsb.js";
import "./color-balance.js";
import "./curves.js";
// 笔刷类（modes=["brush"]）：sharpenBlur 和 liquify 走 filter brush engine
import "./sharpen-blur.js";
import "./liquify.js";
// 艺术组（category="artist"）—— dogfood plugin pattern；后期可剥离成下载插件
import "./mosaic.js";
import "./halftone.js";
import "./stained-glass.js";
