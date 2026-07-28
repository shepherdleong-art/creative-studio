# 智能混剪 V2 · UI 实现技术规格（定稿钉死版）

> 日期：2026-07-25
> 状态：**已与主理人逐屏对齐定稿**。执行时以此文档为准，不要自行发挥布局/配色/交互。
> 上游文档：V2 重构计划 `../plans/2026-07-25-mixcut-v2-reconstruction-plan.md`（Part A 部分由本文档取代并细化）。
> **唯一视觉基准**：`preview/mixcut-v2-ui.html`（单文件可交互样机，四步可切换、含全部交互）。实现 = 把这个样机翻译成 `components/mixcut/` 的 React + CSS Module，不允许偏离。

---

## 0. 执行前必读（三条铁律）

1. **布局/交互/文案照抄样机**。有任何「看起来可以更好」的想法，先提评审，不要直接改。主理人已逐屏验收过样机当前状态。
2. **视觉语言是 Apple 官网式精致极简**（项目主界面同款），不是 MUI。所有 emoji 一律不得出现，图标走 §3 的 SVG 体系。
3. 先读 §8「坑与对策」再动手——那里每条都是本轮实际踩过并修掉的坑，照搬错误实现会原地爆炸。

## 1. 范围与落点

- 改：`components/mixcut/`（MixcutPanel、MixcutSidebar、MaterialStep、CreationStep、PreviewStep、MixcutTimeline、ExportStep）+ `components/mixcut/MixcutPanel.module.css` + `components/ui/Icon.tsx`（补图标）。
- 不改：匹配算法、准备管线、渲染/导出管线、后端 API。Part B（后台提速）是独立工作项，不在本文档。
- 嵌套环境不变：混剪面板嵌在 `app/projects/[id]` 第 5 步 Tab 内，外层 chrome（全局 Header/项目头/五步 Tab）不属于本次范围。shell 高度沿用现有实测内联高度逻辑（`MixcutPanel.tsx` 的 offsetTop 实测 + `max(560, innerHeight-offset-8)`），**但内部必须按 §4 的「钉死骨架、内部滚动」模型组织**。

## 2. 设计 token（照抄到 CSS Module）

```css
--bg:#f5f5f7;            /* 招牌灰底：shell 体、stat 磁贴底、时间轴底 */
--paper:#ffffff;
--line:rgba(0,0,0,.08);      /* 分隔线一律 0.5px 发丝级 */
--line-soft:rgba(0,0,0,.05);
--ink:#1d1d1f; --sub:#6e6e73; --faint:#86868b;
--blue:#0071e3; --blue-hover:#0077ed; --blue-wash:rgba(0,113,227,.08);
--green:#34c759; --green-ink:#248a3d; --orange:#ff9f0a; --red:#ff3b30;
--seg:#e8e8ed;           /* 次级按钮底 / 分段控件轨道 */
--sh-sm:0 1px 2px rgba(0,0,0,.05);
--sh-md:0 2px 8px rgba(0,0,0,.04),0 10px 28px rgba(0,0,0,.06);
--sh-lg:0 24px 70px rgba(0,0,0,.09);
--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,monospace;   /* 时长/时间码/分辨率等数字一律等宽 */
```

尺度约定：

- 正文字号 14/13，辅助 12，角标/标尺 10–11；标题 15–17、字重 600、`letter-spacing:-0.01em`。禁止出现 <10px 文字。
- 圆角：按钮/芯片=胶囊（999px）；面板/卡片 14–16px；shell 18px；时间轴/预览 12–14px。
- 边框一律 `.5px solid var(--line)`，卡片用 `--sh-sm` 投影取代硬边框；大纸（预览区）用 `--sh-md`；shell 用 `--sh-lg`。
- 滚动条：8px，thumb `rgba(0,0,0,.16)` 圆角，无轨道。
- 控件高度：普通按钮 34px、small 28px、主 CTA 48px（带 `0 6px 18px rgba(0,113,227,.25)` 辉光）；select/input 高 ~34px、自绘 chevron、focus 时 `box-shadow:0 0 0 3.5px rgba(0,113,227,.15)`。
- 分段控件（画幅/分辨率/字幕位置）：灰轨 `--seg` radius 9 padding 2，滑块白底 `--sh-sm` radius 7。
- 滑杆：4px 细轨 `#d2d2d7`，16px 白球带 `0 1px 4px rgba(0,0,0,.18)` 投影。
- 顶栏（shell-top）：`rgba(255,255,255,.85)` + `backdrop-filter:saturate(180%) blur(20px)`，56px 高。

## 3. 图标体系

- 全部使用 **1.8px 描边、圆角线帽的 SF 风 SVG**（24 viewBox，`stroke="currentColor"`），播放/停止/完成勾用实心填充变体。样机内是 `ICONS` 字典 + `data-ic` 属性注入（`setIcon`），实现时**收进 `components/ui/Icon.tsx`** 的 name 列表，保持同名：
  `folder / sparkle / play / playCircle / stop / download / upload / check / checkCircle / lock / chevL / chevR / x / plus / mic / speaker / music / photo / refresh / scissors / film / text`。
- 步骤条 4 步图标：folder → sparkle → playCircle → download；已完成步骤换成绿色 checkCircle。
- **禁止 emoji**（包括 🎬🔒🎙💬🎵🖼🔄✂⬆ 等历史遗留），面板标题前缀统一 `<Icon>`。
- 图标默认 15px，`.lg` 18px、`.xl` 22px；按钮内图标 11–12px。

## 4. 骨架与高度模型（最容易做错的一节）

整体：`shell{display:flex;flex-direction:column}` → `shell-top(56px)` + `shell-body{flex:1;min-height:0;display:grid}`。**整页不滚动，只有各区内部滚动**。

列模型（CSS 变量驱动宽度，这是硬要求，原因见 §8.1）：

| 状态 | grid-template-columns |
|---|---|
| 默认（第 1/2/4 步） | `var(--navw,208px) 280px minmax(0,1fr)` |
| + 左侧栏收起 `.colOffA` | `var(--navw,208px) 36px minmax(0,1fr)` |
| 第 3 步 `.preview` | `var(--navw,208px) var(--repw,244px) 6px minmax(0,1fr) 6px var(--rgtw,320px)` |
| 步骤条收起 `.navOff` | `--navw:64px`（叠加在上表任意状态上） |

- 第 3 步：左侧栏（当前素材组/概览/当前步骤/最近会话）**整列隐藏**，换成「素材替换」列 + 两条 6px Resizer + 右栏（字幕样式/BGM/封面）。非第 3 步时 `replace-col`、`.rz`、`right-col` 全部 `display:none`。
- 列内容滚动：步骤条/侧栏/右栏/替换列各自 `overflow-y:auto`；主区每个 Step 根 `display:flex;flex-direction:column;height:100%;min-height:0`，页头/页脚固定，内容区 `flex:1;min-height:0;overflow-y:auto`。
- **主区不放白色大面板**，卡片流直接浮在 `--bg` 灰底上（白卡 + `--sh-sm`）。

## 5. 各步结构与文案（照抄样机，此处只列结构性决策）

### 第 1 步 导入素材
- 页头：STEP 01 / 确认本次混剪要用的素材 / 副行 + 绿点联动提示「已与模块 4 联动，仅显示「{组名}」的真实成功视频」；右侧「同步模块 4」「选择视频」（胶囊按钮带图标）。
- 虚线 dropzone → 工具条（「8 个可用视频 · 6 个将参与混剪」+「恢复全部（已排除 N 个）」）→ 素材网格 `repeat(auto-fill,minmax(172px,1fr))` gap 12。
- 卡片语义**保持止血版**：默认全用、点击=排除/恢复；排除态=虚线框+置灰+「已排除」黑胶囊（左上），角标圆形毛玻璃按钮 ✕/＋；时长右下等宽黑胶囊；底部三行=名称/分辨率（等宽）/来源（参与=绿、排除=灰）。
- 页脚：左侧计数文案，右侧「下一步：AI 智能创作」。

### 第 2 步 AI 智能创作（单列卡片流，禁止多列）
顺序固定：口播文案卡 → 音色卡 → 居中 CTA 区 → 进度卡（任务运行时才出现）。卡片间距 24px、内边距 24px。
- 文案卡：标题行（mic 图标「口播文案（15 秒约 150-200 字）」+ 右侧流程提示「输入文案 → 选音色 → AI 匹配画面 → 出片」）；脚本版本 select（label 内嵌「已同步」chip）；textarea min-height 128；底部「86/500 字（约 24 秒口播）· 来源 · 恢复导入版本」。
- 音色卡：标题 + 服务商 select；**语速行在音色网格上方**（label + 滑杆 max-300 + chip + 说明）；精选音色 6 张/行（mic 图标 + 名称 + 分类 + 「▶ 试听」），选中=1.5px 蓝框+淡蓝底；更多音色行（分类 select + 搜索框 + 试听当前 + 「当前选中：xxx」）。
- CTA 区：`✨(sparkle) 开始智能创作` 48px 大按钮 + 绿色 chip「可用视频素材：6 个」+ 快照提示 caption。不放在页脚。
- 进度卡：6px 胶囊进度条 + 四阶段竖排（done=绿 checkCircle / doing=蓝底白 play / wait=灰序号 / fail=红）；每项右侧计数「7/7 · 已完成」「5/8 · 进行中」。四阶段名沿用现有 STAGES：文案拆分与素材分析 / 逐句口播生成 / 节拍检测与场景匹配 / 预热可预览草稿。

### 第 3 步 预览调整（本规格核心，详见 §6）
四列：步骤条 / 素材替换（可折叠可调宽）/ 主区（工具行 + 大纸）/ 右栏三卡（可折叠可调宽）。

### 第 4 步 导出渲染
- 绿色就绪横幅（`rgba(52,199,89,.09)` 底 + `.5px rgba(52,199,89,.3)` 边，绿勾圆 + 标题 + 摘要 + 右侧 4 个 grey chip）。
- 双卡：导出身份（kv 列表）/ 渲染设置（草稿 select + kv + 2×2 预检清单 + 「可以导出」绿 chip）。预检不通过项用 miss 样式。
- 进度卡 + 居中 48px「开始导出」+「下载整组 ZIP / 下载项目创意包」small 行。

## 6. 第 3 步详细规格

### 6.1 顶栏（shell-top）
左侧 logo+标题；中间项目上下文；**右侧：画幅分段控件（3:4/9:16）+ 分辨率分段控件（1080p/2K）**。画幅/分辨率**不放**在第 3 步控制行（AI-remix 同款位置，主理人已确认）。

### 6.2 顶部工具行（大纸上方）
标题「预览调整」+ chips：`6 片段`(grey) `总时长 24.2s`(blue) `口播 24.2s ✓`(green) + 操作提示 chip「单击选中 · 拖拽排序 · 双击片段/字幕编辑」+ 右侧「已自动保存」caption + 成片草稿 select + 「下一步：导出」primary。

### 6.3 大纸（white + --sh-md, radius 16, padding 14）
自上而下：预览区 →（Trim 条，条件出现）→ 播放控制行 → 三轨时间轴。

- **预览尺寸（钉死）**：`height:clamp(360px,58vh,560px)` + `aspect-ratio:3/4`（9:16 时换对应比例）+ `max-width:min(450px,100%)`。**不要**用「flex 剩余高度」或「容器 min-height」决定预览尺寸（§8.3）。预览大但窗口矮时，整列下滚——这是刻意行为（与 AI-remix 一致）。
- 预览叠加层：虚线安全区（inset 5%、可开关）、中央播放按钮（52px 毛玻璃圆）、字幕（`font-size:clamp(9px,5.2cqw,20px)`，**必须** `container-type:inline-size` + cqw 随预览宽缩放）、右下时间码黑胶囊（等宽 `12.3s / 24.2s`）。
- 播放控制行：蓝色播放/白色停止 30px 方钮 + 等宽时间码 + 右侧「安全区」toggle chip + 快捷键 caption「空格 播放 · ←/→ 微调」。

### 6.4 时间轴（三轨，60px/秒，横向滚动）
- 结构：48px 标签列（不随横向滚动）+ 滚动区。行高：标尺 20 / 视频 64 / 字幕 28 / 音频 30×2。
- 标尺：每秒主刻度（9px 等宽秒标）+ 半秒次刻度（6px 短竖线）。
- 视频片段：真实缩略图铺满（object-fit:cover，无图时渐变兜底）、左上 `#n` 毛玻璃黑胶囊、右下时长胶囊；选中=**内描边** `inset 0 0 0 2px var(--blue)`；圆角 8 + `inset .5px` 细边。
- 字幕块：22px 高白底小圆角；选中=蓝边+淡蓝底、其余压暗 50%；单行省略。
- 音频两行波形：口播=蓝、BGM=灰 `#7d7d85`；条宽 2.5px gap 2；已播放 95% 实色、未播放 22% 淡色（**不要**绿/橙彩色）。BGM 结尾振幅渐隐（实现时按 renderer 数据）。
- 播放头：2px `--orange` + 顶部 8×8 抓手，跨标尺+全轨。
- **音量控件不进时间轴**（§8.4）：只在右栏「背景音乐」卡（音乐音量/口播音量两条滑杆）。

### 6.5 素材调整列（左，对标 MaterialReplaceList）
- 面板标题「素材调整」（refresh 图标）+ 橙色引导文案。素材单击只负责选中，必须显示蓝色高亮和「已选」chip；不能在没有动作确认的情况下直接替换片段。
- 选中素材后显示两个独立动作：「替换当前片段」与「添加到缺口」。裁剪后即使原片段仍保持选中，只要时间轴存在 ≥ 最小片段时长的缺口，「添加到缺口」仍可用；添加位置取第一个可插入缺口。排除的素材不出现在此列。
- 行：38×54 竖版缩略图 + 名称 + 时长·来源（等宽小字）+ 「已用」绿 chip / 「已选」蓝 chip。
- 折叠按钮（右上 ‹）→ 36px 细条（› 展开）；与右栏之间 6px Resizer 拖宽（180–440px）。

### 6.6 右栏三卡（对标 StepPreviewRight）
1. 字幕样式卡：字体 select + 颜色井、大小/描边/间距滑杆（右侧等宽数值）、「对齐」toggle chip、位置分段控件（底部/中下/居中/顶部）、底部 `#1d1d1f` 暗底预览框。
2. 背景音乐卡：曲目 select + 导入(primary)/试听 + 说明 caption + 音乐音量/口播音量滑杆（**音量唯一入口**）。
3. 封面入口卡：54×72 缩略图 + 「视频封面设置」+ 状态行 + ›，点击开现有 CoverEditorDrawer（交互不变）。
- 折叠（› → 36px 细条 ‹）+ 6px Resizer（240–500px）。

### 6.7 Trim 截取条（双击视频片段出现，对标 TrimEditor）
- 位置：预览区与控制行之间。头部：scissors 图标「截取片段 #n · 源素材 {时长}」+ 说明 + 取消/完成。
- 胶片条 72px：源素材全程帧序列（约 0.5s/帧）；蓝色选择框（2px 蓝边、左右把手）可横向拖入点；框外压暗 62%。
- 交互分工（写入操作提示 chip）：单击=选中、拖拽=排序、双击片段=Trim、双击字幕=编辑文案。

## 7. 交互规格（其余）

- **步骤切换**：4 步可点（禁用规则沿用现有：第 2 步需 ≥1 选中素材，第 3/4 步需 preparedGroup）；走过的步骤图标变绿 checkCircle；active=白底 `--sh-sm` + 左 3px 蓝竖条。
- **步骤条收起**（`navOff`）：「创作步骤」右侧 ‹ 按钮 → 64px 纯图标轨（label/hint/「本地保存」文字隐藏），再点展开。
- **左侧栏收起**（`colOffA`，第 1/2/4 步）：面板右上角 ‹ → 36px 细条 ›。
- **第 3 步双栏宽度**：折叠/拖宽的宽度状态**由 JS 持有并写到 `--repw/--rgtw`**，折叠态/宽度记忆存 localStorage（对应 AI-remix `fcp-layout`）。
- **素材排除/恢复**：点卡片切换，联动三处计数（工具条、页脚文案、侧栏「将参与混剪」磁贴）；「恢复全部」一键复位。
- **口播音频倍速**：口播音频轨右键打开横向拉条 + 右侧数值框，范围 0.5x～2.0x、步进 0.1x；拉条与数值框双向同步，调节时立即作用于当前剪辑的口播音轨并自动保存，预览与最终导出必须使用同一倍速。它是生成完成后的音轨播放倍速，与创作阶段的 TTS 语速分开；不得创建新的成片版本或 `prepare` 任务。口播、字幕、BGM 与成片总时长都按调速后的音轨有效时长计算；慢速超出原视频轨时延长末帧，快速时在新终点裁短。
- **自动保存状态**沿用现有 persist 逻辑与文案（正在保存…/已自动保存/已从本地草稿恢复）。

## 8. 坑与对策（执行前必读，逐条都是血泪）

1. **网格规则顺序冲突**：预览态网格定义必须**写在** `.colOffA` 之后（或更高优先级），且预览态永远不受左侧栏收起状态影响。踩坑现象：第 1/2 步收起左侧栏后进第 3 步，36px 窄列落到主区、右栏被撑满全屏。对策：预览态列定义显式给出全部轨道，左侧栏收起态用 `--navw` 变量叠加，不新增列。
2. **非预览态必须隐藏第 3 步专属列**：`.shell-body:not(.preview)` 下 `replace-col`、`.rz`、`right-col` 全部 `display:none`。漏掉任何一条，第 1/2/4 步主区会被挤到隐含列上。
3. **预览尺寸禁止用「容器 min-height + flex 钉死父级」**：样机踩过——预览黑框底角直接戳出大纸圆角边界。钉死做法：预览 `height:clamp(360px,58vh,560px)` 视口驱动 + 大纸 `flex:1 0 auto`（内容驱动高度）+ 整列内部滚动。任何「让预览刚好塞满剩余空间」的写法都会在小窗口重新爆炸。
4. **音量控件禁止放进时间轴滚动区**：先试过轨内 absolute（藏到波形尽头看不到），再试 sticky（波形从条下穿过、右端露出、文字挤成竖排）。终态：**时间轴零音量 UI**，音量只在右栏 BGM 卡。
5. **波形条数按元素实际宽度生成**（offsetWidth/条距），已播放比例按时间比例算，不要写死像素数。
6. **字幕字号跟预览宽度走**：`container-type:inline-size` + `clamp(9px,5.2cqw,20px)`，否则预览缩小时字幕爆出画面。
7. **图片一律带回退**：占位图 `onerror` 移除自身露出渐变底（正式实现=真缩略图 URL 失败时同样兜底），禁止断图破版。
8. **折叠按钮的实现归属**：navOff/colOffA 是 class 驱动；第 3 步双栏的折叠与宽度是 **JS 写 CSS 变量**驱动——两条机制不要混用，尤其不要用 class 改网格列再叠加变量。

## 9. 验收清单（实现后逐条过）

- [ ] 四步切换正常；第 3 步四列、其余三列；第 3/4 步左侧栏隐藏规则正确。
- [ ] 第 1/2 步收起左侧栏 → 进第 3 步：网格仍 `navw/repw/6/1fr/6/rgtw`，主区不缩、右栏 320（回归 §8.1）。
- [ ] 步骤条收起到 64px 图标轨，四步都正常。
- [ ] 素材排除/恢复/恢复全部，三处计数联动；端到端落到 `selectedMaterialKeys`。
- [ ] 窗口 1280×650 ~ 1440×900 范围：预览底边**永远在大纸内**（程序测 `preview.bottom < bigpaper.bottom`）；不出现横向页面滚动。
- [ ] 时间轴横滚时：标签列不动、音量 UI 不存在于时间轴、波形单色（口播蓝/BGM 灰）。
- [ ] 双击片段开 Trim、拖动选择框、完成/取消收回；单击素材有明确高亮，可分别替换当前片段或添加到裁剪/删除形成的缺口。
- [ ] 右键口播音频轨显示 0.5x～2.0x 拉条和同步数值框；拖动立即改变当前音轨，松手后自动保存，预览与导出一致，且不创建新版本或 `prepare` 任务。
- [ ] 全文无 emoji；图标全部来自 `Icon.tsx`；数字均为等宽字体。
- [ ] `npm run lint` 0 error、`npm run build` exit 0；两个 Playwright（mock UI + 真实 E2E）通过。

## 10. 参考文件

- 视觉基准（唯一样机）：`preview/mixcut-v2-ui.html`
- 实现落点：`components/mixcut/*`、`components/mixcut/MixcutPanel.module.css`、`components/ui/Icon.tsx`
- 设计语言出处：`/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool/src/renderer/`（布局/交互逻辑参考；视觉已按 §2 转为 Apple 风，**不再**照搬其 MUI 表皮）
- 上游计划：`docs/superpowers/plans/2026-07-25-mixcut-v2-reconstruction-plan.md`（Part B 后台提速仍按该文档执行）
