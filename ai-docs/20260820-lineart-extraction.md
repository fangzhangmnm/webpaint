# 线稿提取（上色图→线稿层）：模型选型、管线、墨色估算——2026-08-20 夏音案实战沉淀

> as-of 2026-08-20（首例实战：`20260820-夏音线稿.ora` 宣发素材，从 v0.2 destructive collapse 后的单层上色图反提取线稿）
> 性质：**离线工具管线 + 将来 in-app AI 纪元功能的选型依据**。产品弧位置：0.10混色→**AI**→text→timelapse→1.0（见总集篇 memory）。
> 注意方向：本文是「上色图→线稿提取」；repo 里已有的 `lineart` 全家（flat-coloring/线稿闭合）是**反方向**（线稿→填色），别搞混。

## 1. 模型选型（2026-08-20 双模型对赛，目视裁决）

| 模型 | 权重 | 参数 | 结构 | CPU耗时(1299×1528) | 裁决 |
|---|---|---|---|---|---|
| **MangaLineExtraction (erika.pth)** ✅胜 | 173MB fp32 | ~43M | 残差U-Net `res_skip`，5级尺度 24→48→96→192→384，**全分辨率24ch主干** | ~30s | 线实、完整，睫毛级细节保留；采用 |
| informative-drawings anime (netG.pth) ✗ | 218MB fp32 | ~54M | pix2pix式U-Net 8下采样 ngf=64，首层即stride-2 | ~3s | 快10倍但线发虚、铅笔感，宣发不可用 |

- 其他备选（未跑，按知识判断）：Anime2Sketch（与netG同门同构，同样偏软）；sketchKeras（古典，不如erika）；HED/PiDiNet/DexiNed（通用边缘检测，出"边缘"不出"线稿"，二次元满脸碎线，不推荐）。SD 生态的 lineart preprocessor 就是这两个的皮。
- **结论：二次元上色图→线稿，erika 是甜点**。质量不满意时先调后处理，别急着换模型。
- 权重来源：HuggingFace `lllyasviel/Annotators`（`erika.pth` / `netG.pth`）。

## 2. 现成工具（可复用，已落盘）

- **`~/jupyter/third-party/lineart-extract/`**（家规检疫桶）：
  - `venv/`：画画专用 CPU torch venv（与 `~/venvs/pytorch` 的 LLM 环境分开，user 2026-08-20 拍板可分）；
  - `models/erika.pth`、`models/netG.pth`；
  - `manga_line_model.py`（`res_skip` 定义，源=ljsabc/MangaLineExtraction_PyTorch，已剥 cv2 依赖）、`lineart_anime_model.py`（UnetGenerator，从 controlnet_aux 源码裁出，纯 torch）；
  - `run_extract.py`：驱动脚本（ora 拆层→白底合成→双模型推理→线图 png）。改 ora 路径/层名即可复用。
- **不需要 GPU**：全分辨率 CPU 秒~分钟级。eGPU 免了。

## 3. 管线（每步都有为什么）

1. **拆 ora 按图层分别提取**（user 指令「眼睛和身体分别提取」）：每层各自在白底上合成（straight alpha → over white）再喂模型。理由：跨层污染——眼睛层的线如果连着身体层颜色一起提取，暗色虹膜会整块被当成线。产出线稿层保持原分层语义、各回各的 x/y offset。
2. **推理必须全分辨率**：
   - erika：灰度 0-255 直喂（**无归一化**），pad 到 16 倍数（原作者用 `np.ones` 填充，照抄），推理后裁回。**无缩放**。
   - netG（如果用）：RGB `/127.5-1`，**缩放**（bicubic）到 256 倍数再缩回——它天生有重采样损失，这也是它糊的原因之一。
   - controlnet_aux 的封装**默认把图缩到 512**（`detect_resolution=512`），直接用它的 detector 会毁质量——所以才手写驱动。
3. **线图→alpha 线稿层**：模型输出白底黑线灰度图 L → `alpha = 255 - L`，RGB 填估算墨色（§4）。**灰雾清零**：`alpha < 8`（~3%）置 0，去掉模型的背景噪声，否则整层浮一层脏。
4. **组装 ora**：新线稿层插到对应色层上方；mimetype 首项 STORED（ORA 规范）；mergedimage/thumbnail 诚实重算。**永不覆盖源文件**，产出新文件。
5. **源新鲜度自查**：提取前 hash 对比源文件——夏音案中途 user 重存过源（身体层改了 7 万像素），靠 md5 抓到才没交付过期货。

## 4. 墨色估算（宣发确认的需求：线稿提取必须带墨色，不出纯黑）

- **v1（已验证，够用）**：线稿 alpha 当掩膜，取强线像素（alpha ≥ 0.78 即 ≥200/255）对源图（白底合成后）采样，**取中位数** → 该层单一墨色。
  - 夏音实测：身体线 `#5f222c` 暗酒红，眼睛线 `#3c2634` 暗梅紫。
  - **必须 per-layer/per-次提取各估一次**——同一张画不同部位墨色就不同，全局一个色是错的。
- **【翻车教训】反解全不透明墨色不可用**：把抗锯齿混色按 src-over 解回去（`ink = (c - bg·(1-α))/α`）假设 bg=白底——实际线压在粉发/肤色上，解出来 G/B 通道清零、红黑失真（`#3d0000`）。**估墨色绝不能假设底色**。
- **v2（后置，如果要渐变色线稿）**：先用线周围非线像素中位数补出线底下的局部背景色，再逐像素用真实局部 bg 反解墨色 + 平滑——即手绘圈「线稿上色」效果。成本高一档，产品判断归人类。

## 5. in-app 化（AI 纪元）可行性账

- **体积**：fp16 ≈ 86MB / int8 ≈ 43MB（判别式小模型 int8 质量损失很小）。是 app 本体的 10-40 倍 → 不进主 bundle，懒加载 + Cache API/OPFS。**分发方式（物理进仓 vs 自家 Pages dist 同源下发）触碰 vendor 家规，归人类拍板，未决**。
- **算力**：iPad WebGPU（ONNX Runtime Web）估 3-10s/张；WASM+SIMD 兜底 1-2min。导入时一次性操作，非热路径，可接受。
- **内存**：大头是 erika 的全分辨率 24ch 激活；fp16 + overlap 分块推理（全卷积网络可切 tile）压到几百 MB，iPad 可行。
- **导出**：两模型纯卷积，torch→ONNX 无坑。
- 接入点参考：`scripts/mcp-server.mjs` 已能 headless 开 ora/加层/导出；in-app 侧若做成 filter kernel，注意本任务是「新建线稿层」不是「原层滤镜」，形状要过 grill。

## 6. 已知局限 / 下次注意

- 源层里烤死的旧线会跟着提出来（夏音案：身体层的闭眼睫毛在开眼线稿下露出，需手擦两笔）——提取不会分辨「哪些线属于当前形态」。
- 模型输出线宽略随输入分辨率变化；巨幅画布如需一致手感，可试固定实际 DPI 分块。
- 交付进 OneDrive appfolder 本地镜像时,与 WP 云端直写存在同步竞态——夏音案由此牵出 open 路径冲突 surface 红线 bug（已修 v0.2.1，详 `20260820-open-time-conflict-surface-handoff.md`）。投递后让 user 在 WP 里开档确认。
