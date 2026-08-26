# DXF 编辑器 / 预览（思源集成版）

在思源笔记内直接预览、轻量编辑 DXF 图纸的**插件 + 挂件**组合。基于纯前端、零 CDN、完全离线的 Canvas2D 引擎，支持 ASCII 与二进制 DXF、图层开关/冻结、模型/布局切换、文字提取、测量标注、嵌入当前笔记等。

> 本仓库为**插件包**：内含 `widget-assets/`（挂件 / viewer）。安装插件后，插件会自动把挂件部署到思源 `data/widgets/`。挂件也可作为独立包安装，见「五、安装」。

---

## 一、项目优势

- **思源内原生体验**：点击文档中的 `.dxf` 附件即在右侧 dock 打开预览，拦截思源自带的 DXF 文本预览；也可右键把图纸以可交互挂件嵌入当前笔记。
- **完全离线、零外部依赖**：纯前端 Canvas2D 引擎，无 CDN、无后端、无联网，图纸数据不出本机，适合工程 / 涉密环境。
- **SHX 字体零字库依赖（核心优势）**：SHX 字体默认映射为系统字体（Tahoma / 宋体等）渲染，彻底消除 SHX 矢量描边的「白团 / 1px 最小线宽刺猬 / 缩放比例失调」等长期顽疾，且**思源与单机 `index.html` 显示像素级一致**。
- **显示与单机 HTML 完全一致**：关闭了思源嵌入模式的「文字放大 boost」，同一缩放级别下画面与单机打开 `index.html` 完全相同。
- **自适应工具栏与布局**：顶部工具栏随窗口宽度自动换行；canvas 按父容器尺寸动态同步、每帧重绘，无底部白线 / 残影。
- **轻量编辑能力**：支持图层显隐 / 冻结、模型空间与图纸空间（布局）切换、文字框选提取、距离 / 坐标测量，以及通过 DXF 写出做轻量属性修改。
- **自动部署挂件**：插件加载时把内置 viewer 部署到 `data/widgets/`，无需手动放置挂件文件；版本不匹配时自动更新。

---

## 二、实现原理

### 1. 插件入口（`index.js`）
- 监听文档内 `.dxf` / `.dwg` 附件的点击事件，阻止思源默认把 DXF 当文本预览，改为打开右侧「DXF 预览」dock。
- 提供右键菜单：用预览打开、以挂件嵌入当前笔记、复制嵌入 URL。
- 加载时执行 `_deployWidget()`：比对 `DEPLOY_VERSION` 常量与 `widgets/.deployed-version`，不一致则用插件私藏的 `widget-assets/` 覆盖 `data/widgets/siyuan-dxf-editor/`，保证挂件始终与插件同版本（这是修复「改了代码却不生效」的关键机制）。
- 通过 `iprotyle.getInstance().insert(html, true)` 将 iframe 形式的 viewer 插入笔记。

### 2. 挂件（Canvas2D 渲染器）
- `dxf-parser.js` + `dxf-binary.js` 将 ASCII / 二进制 DXF 解析为实体对象树（LINE / CIRCLE / ARC / LWPOLYLINE / TEXT / MTEXT / INSERT / DIMENSION / HATCH …）。
- `dxf-render.js` 负责：
  - **视图变换**：`setTransform(dpr * ss)` 做 2x 离屏超采样，再 `_blitOffscreen` 缩回显示 canvas（净效果 1 绘制单位 = 1 CSS 像素，与 dpr / 缩放无关）。
  - **几何绘制**：按图层可见性、颜色索引（ACI→RGB）绘制矢量图元。
  - **文字**：默认 `useSystemFontForShx=true`，SHX 字体经 `acad-fmp` / `SHX_SUBST` 表映射为系统字体族后用浏览器原生字体**填充式**渲染；字号与正常 TrueType 系统字体一致，彻底规避描边类问题。
  - **交互**：平移 / 缩放（滚轮、框选）、测量、文字框选提取、图层管理。
- `app.js` 负责文件加载（内置「打开」、拖拽、`?file=` 参数）、交互工具调度、与思源 iframe 通信；默认系统字体模式下跳过 SHX 字形预加载（v1.0.26 优化）。

### 3. SHX 兜底（可选关闭）
`useSystemFontForShx=false` 时走 `shx-parser` + `shx-fonts` + `fonts/*.shx` 的矢量描边渲染，保留作特殊图纸兜底。

---

## 三、使用语言与技术栈

- **语言**：JavaScript（ES5 / ES6 混用，兼容思源 Electron 运行环境）、HTML5、CSS3。
- **核心引擎**：Canvas 2D（`OffscreenCanvas` 离屏 2x 超采样 + `drawImage` 缩回）。
- **解析库（内置）**：`dxf-parser.js`（DXF 实体解析）、`dxf-binary.js`（二进制 DXF 解码）、`dxf-writer.js`（DXF 写出）。
- **字体**：`acad-fmp.js`（AutoCAD 字体映射表）、`shx-fonts.js` / `shx-parser.umd.js` / `shx-calib.js` / `fonts/*.shx`（SHX 矢量兜底）。
- **宿主集成**：思源笔记插件 API（`index.js` 调用内核 `iprotyle`、`/api/...`），插件 manifest `plugin.json`、挂件 manifest `widget.json`。
- **无构建步骤**：纯静态资源，无需 npm 打包 / 编译，放置即用。

---

## 四、各代码文件功能

| 文件 | 作用 |
|------|------|
| `index.js` | 插件入口：附件点击拦截、右键菜单、dock 面板、挂件自动部署（`_deployWidget`）、iframe 嵌入笔记 |
| `plugin.json` | 插件元数据（名称、版本、作者、minAppVersion、描述、入口声明） |
| `README.md` | 本说明文档 |
| `widget-assets/index.html` | 挂件页面骨架：顶部工具栏、状态栏、canvas 容器；按 `?embed=1` / `?dock=1` 标识嵌入模式 |
| `widget-assets/widget.json` | 挂件元数据 |
| `widget-assets/dxf-render.js` | 渲染器核心：视图变换、几何绘制、图层、文字（SHX→系统字体映射）、测量、缩放 / 平移、离屏超采样 |
| `widget-assets/app.js` | 应用逻辑：文件加载、拖拽、`?file=` 参数、交互工具、字体预加载、与思源通信 |
| `widget-assets/dxf-parser.js` | 将 ASCII / Binary DXF 解析为实体对象树 |
| `widget-assets/dxf-binary.js` | 二进制 DXF 段读取与解码 |
| `widget-assets/dxf-writer.js` | 轻量 DXF 写出（属性 / 实体修改保存） |
| `widget-assets/shx-parser.umd.js` | SHX 字形矢量解析（兜底模式） |
| `widget-assets/shx-calib.js` / `.json` | SHX 字形标定数据 |
| `widget-assets/shx-fonts.js` | SHX 字体表与映射逻辑 |
| `widget-assets/acad-fmp.js` / `.json` | AutoCAD 字体映射表（SHX 字体名 → 系统字体名） |
| `widget-assets/fonts/*.shx` | SHX 字形文件，仅 SHX 矢量兜底模式使用 |

---

## 五、安装（插件与挂件都要安装）

本项目的**插件**和**挂件**是两个独立包，**都需要在思源集市（或手动）安装**：

1. **安装插件 `siyuan-dxf-editor`**
   - 集市安装：思源「设置 → 关于 → 市场（或插件入口）→ 添加市场」，填入插件仓库地址 `https://github.com/1577967449/siyuan-dxf-editor`，搜索安装。
   - 或手动：把本仓库内容放到 `data/plugins/siyuan-dxf-editor/`，重启思源或重载插件。
   - 插件加载后会**自动部署**内置挂件到 `data/widgets/siyuan-dxf-editor/`。
2. **安装挂件 `siyuan-dxf-editor`**（独立包，仓库 `https://github.com/1577967449/siyuan-dxf-editor-widget`）
   - 集市安装：同上「添加市场」填入挂件仓库地址，搜索安装挂件。
   - 或手动：把挂件仓库内容放到 `data/widgets/siyuan-dxf-editor/`。
3. **重启思源**：完全退出思源再重新打开，确保插件自动部署最新挂件并刷新 iframe 缓存。

> 说明：插件已内置挂件并会自动部署，因此「只装插件」通常也能用；但为确保挂件也受集市版本管理、且在部分环境下不被覆盖，建议**插件与挂件都安装**。两者同名（`siyuan-dxf-editor`）但分属插件 / 挂件两类，不会冲突。

---

## 六、使用说明

- 点击文档中的 `.dxf` 附件 → 右侧「DXF 预览」dock 打开图纸。
- 右键附件 →「用 DXF 预览打开」：手动打开 dock。
- 右键附件 →「以 DXF 挂件嵌入当前笔记」：在当前笔记插入可交互挂件块。
- 挂件内：滚轮缩放、拖拽平移、顶部工具栏切换图层 / 布局、测量、文字提取、打开本地文件、拖拽载入。

---

## 七、关于 DWG 图纸的显示建议（重要）

本项目聚焦 **DXF** 的预览与轻量编辑。对于 **DWG**（AutoCAD 原生二进制格式），经多方案实测对比，给出以下建议：

- **推荐使用 `@x-viewer` 项目显示 DWG。**
  - 开源方案 `mlightcad`（社区 Web CAD 内核）在**大图渲染偏慢**，且**面对带外部参照（XREF / 参照图纸）的图纸会出现显示问题**，需要额外的修复与适配工作。
  - `@x-viewer` 虽为**闭源**项目，但**可以使用 AI 工具构建自用版本**；经实测，它是目前**最易用、且基本无需处理显示问题**的方案，适合作为 DWG 预览的首选。
- 若你有 DWG 需求：建议先将 DWG 转 DXF 后由本插件预览，或直接采用 `@x-viewer` 方案；本插件暂不直接解析 DWG 二进制。

---

## 八、DXF 兼容性说明（需无自定义对象）

- 本渲染器覆盖常见二维 DXF 实体（LINE / CIRCLE / ARC / LWPOLYLINE / POLYLINE / TEXT / MTEXT / INSERT / DIMENSION / HATCH / POINT 等）。
- **DXF 需为「无自定义对象（no custom objects / proxy entities）」的标准图元**：若图纸含有第三方插件生成的自定义对象（如天正系列的部分图元、或需 Object Enabler 的代理实体），这些对象在纯文本 DXF 中可能丢失或仅显示为代理图形，预览会不完整。
  - 建议：在 AutoCAD / 天正中执行 `EXPLODE` / `AUDIT`，或另存为「AutoCAD R12/LT2 DXF（明文）」「分解后 DXF」，尽量转为标准基本图元后再用本插件预览。
- 超大 DXF（数十 MB、实体数十万）由主线程解析，偶有卡顿，属已知限制。

---

## 九、已知问题

- 部分图纸中存在随缩放显隐的细线（商业 CAD 中通常为隐藏 / 冻结实体），当前渲染器尚未完全过滤。
- 超大型 DXF 由主线程解析，偶有卡顿。
- DWG 不在本插件直接支持范围，见第七节。

---

## 十、版本历史

- v1.0.26 — **代码优化：清除 SHX 相关无效内容（保守清理）**：
  1. 删除 `_drawTextSys` 的死参数 `shxMode`（函数体内已不再使用）。
  2. 重写 `_drawText` 入口：默认 `useSystemFontForShx=true` 时不再白解析 `ShxText.resolveStyle`（原 `st` 只用于已移除的 `shxMode`），也移除永为 falsy 的 `e._forceSys` 死条件；仅当开关关闭（旧矢量描边兜底）时才解析并走 `_drawTextShx`。
  3. `app.js` 的字体预加载：默认系统字体映射模式下跳过 `preloadFonts()`，不再无谓 fetch SHX 字形数据、不再多触发一次重渲染；旧模式（`useSystemFontForShx=false`）仍正常预加载。
  4. 旧 SHX 描边路径（`_drawTextShx`/`_wrapLineShx`）与 4 个 SHX 参数、开关均保留作兜底，未删除。
  5. 验证：`node --check` 通过；`test_shx_sysfont.js` 仍 PASS（默认走系统字体、关闭走 SHX 描边）；`shxMode` 全仓零残留。
- v1.0.25 — **SHX 映射字体大小与正常字体大小一致**：
  1. 修复 v1.0.24 中 SHX 映射为系统字体后仍沿用 `textScaleShx=4.0` 的问题，导致映射字体比正常 TrueType 系统字体大 4 倍、重叠/错位。
  2. 改为：SHX 映射后统一使用 `textScaleSys=1.0` 与系统字体相同的 min/max 限制，字号与正常系统字体完全一致。
  3. 旧 SHX 描边路径（`useSystemFontForShx=false`）仍保留 `textScaleShx=4.0` 作为兜底。
- v1.0.24 — **SHX 字体映射为系统字体，彻底去除 SHX 字库依赖**：
  1. 新增开关 `useSystemFontForShx`（默认 `true`）。开启后，所有 SHX 文字实体（TEXT / MTEXT / ATTRIB / DIMENSION 文本）不再走 `ShxText` 矢量描边，而是经已有的 `SHX_SUBST` 表把 SHX 字体名（如 `txt.shx` / `hztxt.shx`）映射为系统字体族（Tahoma / 宋体…），用浏览器原生字体引擎**填充式**渲染。
  2. 好处：① 彻底消除 SHX 描边的「白团 / 1px 最小线宽 / 缩放比例」等显示问题；② 不再依赖 `shx-fonts.js` 字库，加载更轻、跨平台字体一致；③ 思源与单机 index.html 使用同一套系统字体路径，显示完全一致。
  3. 开关可关：设 `useSystemFontForShx=false` 即恢复旧 `ShxText` 描边行为（保留作兜底）。
- v1.0.23 — **思源显示与单机 index.html 完全一致（关闭 embed 文字放大 boost）**：
  1. 根因：之前 `fit()` 在思源 `embedMode`（?embed=1 / ?dock=1）下会调用 `_ensureReadableText()`，把视图放大最多 5 倍来「增强文字可读性」，导致思源里文字比几何图形大得多，与单机 index.html 比例不一致。
  2. 修复：新增开关 `boostTextInEmbed`（默认 `false`），`fit()` 仅在 `embedMode && boostTextInEmbed` 时放大；默认关闭后思源走与单机完全相同的 `zoomExtents()`，文字随视图比例缩放，与几何保持同一比例。
- v1.0.22 — **取消 SHX 放大上限，修复放大时字体缩小一半**：`maxTextPxShx` 改为 `0`（不限制），放大时 SHX 字高与几何图形同步线性增长，不再被 256px 截断。
- v1.0.21 — **修复 SHX 字高随缩放比例错误**：`ShxText.layoutLine` 期望字高为模型单位，旧版误传屏幕像素导致字高按 `s²` 缩放；改为传模型单位后字高随 `s` 线性同步。
- v1.0.20 — **SHX 线宽恒定 1px、字高随缩放同步**：`lineWidth` 固定为 `shxLineWidth=1`，字形仍经 `SX/SY` 缩放，实现「字高随页面变化、笔画恒为 1px」。
- v1.0.19 — SHX 描边恢复随页面缩放同步（`naturalH/30`）。
- v1.0.18 — SHX 描边线宽固定为 1px。
- v1.0.17 — 顶部工具栏自适应换行 + SHX 字体进一步防白团。
- v1.0.16 — 修复「底部白线/残影」真正根因（canvas 尺寸来源改为 parentElement）。
- v1.0.11 — 修复「思源里字体与单机 index.html 不一致」（取消文字绝对像素下限，改为随视图比例缩放）。
- v1.0.10 ~ v1.0.1 — 早期 SHX 描边、嵌入逻辑、工具栏等迭代（详见提交历史）。
