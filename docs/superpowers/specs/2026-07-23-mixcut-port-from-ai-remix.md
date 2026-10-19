# 混剪工具移植执行文档:AI-remix → creative-studio

> 日期:2026-07-23
> 状态:待执行
> 执行前提:执行会话必须能读取源工程 `/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool/`(下文简称 **源工程**,所有 `src/...`、`backend/...` 相对路径均指源工程内路径)。
> 本文档面向**没有任何上下文的新执行会话**,按阶段执行,每阶段有独立验收标准。

---

## 〇、一句话任务

把源工程(短视频智能混剪,Electron + React 18 + Python FastAPI)的**交互与实现逻辑**完整移植进 creative-studio,替换现有第五步「成片混剪」(final-edit)模块。**技术栈全部落在 creative-studio 现有的 Next.js 16 + React 19 + Node/TS + SQLite 体系上,零 Python、零 Electron、不引入 MUI/Tailwind。**

主理人已实际验证源工程效果优于现有 final-edit,方向已定,不需要再论证「是否值得」。要求:**交互 1:1 保真,算法逐个翻译,平台坑按本文档红线清单规避。**

---

## 一、决策背景(为什么这么做)

1. 现有 final-edit(`lib/final-edit/` + `components/final-edit/`,约 5.3k 行)走「脚本主导编排」路线,效果不如源工程的「音频优先匹配」(Audio-First Match)管线。
2. 源工程真正干活的是 ffmpeg,Python 只是命令构造 + 编排层皮,可翻译。核心求解器 `backend/services/match_solver.py` 是纯标准库最小费用流,无第三方依赖,可直接翻成 TS。
3. creative-studio 已有大量可复用底座:`lib/ffmpeg.ts`(ffmpeg 解析)、`lib/script-providers/`(LLM completeJson,支持多模态 images)、`lib/final-edit/adapters/tts-registry.ts`(vapi-qwen3-tts,**已返回逐句 segmentTimings 与 wordTimings**,天然满足 split-tts 的核心需求)、`lib/final-edit/adapters/video-analysis.ts`(多帧抽样 vision 分析)、job 队列与 heavy-job-lock、storage 路径体系、桌面打包体系。
4. 桌面安装包哲学(自带私有 Node runtime、双平台 Inno Setup / .app)不允许捆 Python runtime,因此**不做 sidecar,直接 TS 重写**。

## 二、范围

### 本次做(阶段 0–5)

源工程**单条精细模式**的完整四步流程(素材导入 → AI 智能创作 → 预览调整 → 导出渲染),含全部子交互(FCP 三轨时间线、Trim 重选时段、字幕逐句编辑与拖拽、WYSIWYG 封面编辑器、BGM、音色试听、画幅/分辨率)与全部后端管线(场景检测、视觉分析、文案分析、分句 TTS、节拍检测、约束求解匹配、预览快拼、成片合成)。

### 明确延后(阶段 B,验收后另启)

- **批量生产向导**(源工程 `src/renderer/components/batch/`,5 阶段:上传 → 预修 → 脚本 → 分配审改 → 导出;后端 `routes/batch.py` 1755 行 + `concurrent_analyzer.py`/`batch_service.py`/`batch_allocator.py`)。
- **豆包 Doubao TTS**(`backend/services/doubao_proto.py`,WebSocket 二进制协议)——先只接现有 vapi-qwen3-tts,豆包做成 tts-registry 新适配器后补。
- **模板市场/模板编辑器**(`src/renderer/components/template/`、`store/template-store.ts`)——与主流程独立,不移植。

> ✅ 已确认(2026-07-23):主理人实盘验证的就是**单条精细模式**,上述范围与阶段顺序即最终定案,阶段 B 维持后置。

### 不做

- 不保留旧 final-edit 的「群组/变体/提案(proposal)」编排 UI。底层可复用模块(见 §六.1)保留。
- 不在 UI 里明文输入 API Key(与源工程不同,creative-studio 的 Key 走服务端配置,见 §六.4)。

---

## 三、源工程地图(执行时按需精读)

| 路径 | 内容 | 移植关系 |
|---|---|---|
| `AGENTS.md`、`HANDOFF.md` | 架构、硬 bug 教训、现状 | 必读,红线来源 |
| `docs/prd-match-audio-first.md`、`docs/design-match-audio-first.md` | 音频优先匹配 PRD/设计 | 必读,管线权威定义 |
| `src/renderer/App.tsx` | 入口双模式(select/single/batch) | 本次只移植 single |
| `src/renderer/components/layout/AppShell.tsx` | 四步壳:左侧步骤导航+左右可折叠可拖宽面板 | 交互 1:1 移植 |
| `src/renderer/components/layout/StepLeftPanel.tsx` / `StepRightPanel.tsx` | 每步的左右辅助面板 | 交互移植,Key 面板改造(§六.4) |
| `src/renderer/components/materials/*` | 第 1 步素材管理(网格/列表/筛选/详情/导入对话框/项目历史) | 交互移植,数据源改造(§六.5) |
| `src/renderer/components/analysis/AiScriptEditor.tsx` | 第 2 步:文案+音色+四阶段编排(含取消/降级) | 交互与编排逐行对照移植 |
| `src/renderer/components/analysis/TimelineEditor.tsx`(1110 行) | 第 3 步:预览+字幕+BGM+Trim+封面编辑器(CoverEditor/CoverPresets 也在此文件) | 交互 1:1 移植 |
| `src/renderer/components/timeline/FcpTimeline.tsx`、`TrimEditor.tsx`、`fcpTimelineConfig.ts`、`waveformPeaks.ts`、`mediaUrl.ts` | FCP 三轨时间线与 Trim | 交互 1:1 移植 |
| `src/renderer/components/render/ExportConfirm.tsx` | 第 4 步:导出(WYSIWYG 换算全部在此) | 逐行对照移植,换算公式照抄 |
| `src/renderer/utils/coverFit.ts` | 封面文字测量/平移-缩放适配(fitTitleLine/computeCoverFit/measureTextWidth) | 直接翻译(纯浏览器逻辑,可近原样复制) |
| `src/renderer/store/editing-store.ts` | 全局编辑状态(时间线/字幕/封面/BGM/画幅,persist) | 状态形状照搬,持久化改服务端(§六.6) |
| `src/renderer/store/materials-store.ts` | 素材状态(persist) | 同上 |
| `backend/routes/ai_editing.py`(1122 行) | 全部管线端点 | 翻成 Next.js API routes |
| `backend/routes/preview.py` | 预览快拼 assemble | 翻译 |
| `backend/routes/music.py` + `services/music_service.py` | BGM 列表/导入/串流 | 翻译 |
| `backend/routes/projects.py` | 项目历史保存/恢复 | 并入 mixcut session 持久化 |
| `backend/services/ai_service.py` | LLM 提示词(analyze_script/打分矩阵+hook)、vision 帧描述、qwen TTS、重试 | 提示词原样照搬,调用层换 script-providers |
| `backend/services/match_solver.py`(482 行) | 最小费用流求解器 | **逐行翻译为 TS,行为对拍**(§七阶段 1) |
| `backend/services/video_service.py` | 场景检测/抽帧/composite_clip/字幕烧录/封面渲染 | ffmpeg 命令逐条对照翻译 |
| `backend/services/beat_detect.py` | silencedetect 气口检测 | 翻译 |
| `backend/services/scene_cache.py` | 场景描述缓存(md5 键) | 翻译 |
| `backend/config.py` | 默认参数(阈值/模型/并发) | 参数值照搬(§五.9 参数表) |

---

## 四、交互规格(1:1 保真)

> 视觉样式(颜色/圆角/间距)按 creative-studio 现有设计语言用 CSS Modules 重做;**布局结构、控件集合、行为语义必须与源工程一致**。以下是行为契约,细节以源文件为准。

### 4.0 全局壳(AppShell)

- 顶栏:模块标题 + 全局画幅控制(GlobalAspectControl,9:16 / 3:4 切换,全局生效)+ 主题切换(接 creative-studio 现有主题体系)。
- 左侧步骤导航(4 项):`导入素材(选择文件夹)` `AI 智能创作(分析·脚本)` `预览调整(时间线·封面)` `导出渲染(成片输出)`。点击自由跳转;已访问过且非当前的步骤显示绿色对勾;当前步骤高亮 + 左缘竖条。
- 工作区三栏:左辅助面板(默认 264px,可拖宽 200–440,可折叠成 36px 条)+ 中央步骤主区 + 右辅助面板(默认 320px,可拖宽 240–500,可折叠)。布局状态持久化。
- **四个步骤组件全部常驻挂载,用 display:none 切换**——步骤切换不销毁任何状态(源工程铁律,防止播放/轮询/表单状态丢失)。

### 4.1 第 1 步 · 素材导入

- 工具栏:导入按钮、已选计数 Chip(可一键取消全选)、批量删除、搜索框、类型筛选(全部/视频/图片)、状态筛选(就绪/导入中/等待中/失败)、清除筛选、网格/列表视图切换、素材总数(筛选时显示「显示 N 个」)。
- 全屏拖拽导入:dragenter 显示虚线遮罩「释放以导入素材」,支持 MP4/MOV/AVI/WebM。
- 导入流程逐文件:先建 `importing` 占位卡 → 校验(validate)→ 探测元数据(probe:时长/分辨率/大小/fps/codec/码率)→ 生成缩略图 → `ready`;失败置 `error` 不中断其余文件。
- 选择:单击单选、Ctrl/Cmd+单击多选、Shift+单击范围选、复选框逐个切换、列表头全选。
- 素材详情抽屉(MaterialDetail)+ 项目历史(ProjectHistory,恢复既往会话)。
- **creative-studio 化差异(允许)**:素材池自动预置当前项目已完成的视频结果(见 §六.5),外部导入作为补充;两类素材统一展示,标注来源。

### 4.2 第 2 步 · AI 智能创作

- 口播文案卡:多行输入,maxLength 500,占位示例文案,下方实时字数 +「约 N 秒口播」(N = 字数/5)。标题注明「15秒约150-200字」。
- 音色选择卡:
  - 当前服务商说明文字;语速滑杆 0.5–2.0 步进 0.1(标记 0.5x/1x/1.5x/2x + 当前值 Chip + 提示文案「语速越快…建议 0.9–1.1x」)。
  - 「精选常用」两行 12 张卡片(按名字关键词挑选,不硬编码 ID),点卡片选中、卡内「试听」按钮独立试听(生成短样本播放,试听中禁用)。
  - 「更多音色」:性别筛选(全部/女声/男声,仅作用于下拉)+ 可搜索 Autocomplete(输入与选中名相同则不过滤,展示全部可滚动)+ 「试听当前」按钮 + 当前选中说明。
  - 音色列表从后端动态加载(`/voices?provider=`),失败用兜底列表;切服务商时若当前音色不在新列表则重置为首个。
- 主操作:居中大按钮「开始 AI 剪辑」(无文案或无就绪素材时禁用);运行中变为「取消生成」;取消后变为「重新生成」。下方 Chip 显示「可用视频素材: N 个」。
- 运行编排(**核心,与源工程完全一致**):
  1. Phase 1 并行:`analyze-script`(拆 5-8 段)+ 逐素材 `analyze-video`(**并发 5 一批**,进度文案「分析视频 i/N...」)。
  2. Phase 2:`split-tts` 逐段 TTS → 真实 `seg_durations` + `total_duration` + `audio_path`;**TTS 失败降级**:按 0.22s/字(下限 1.0s,取整到 0.1s)估算时长继续匹配,提示「成片将无配音」,不中断。成功后自增 audioVersion 强制第 3 步丢弃旧语音缓存。
  3. Phase 3 并行:`detect-beats`(非关键,失败静默)+ `match-scenes-v2`(带 segments/seg_durations/scenes/beat_points)。
  4. 匹配完成后**后台预热第 3 步预览**(同参数调 assemble,失败无妨)。
- 进度 UI:四行阶段(等待⚪/运行▶/完成✅/错误❌ + 消息),determinate 总进度条(完成阶段数比例 + 运行中阶段折半),右上角「当前阶段消息 · 已用时 Ns」。取消用 AbortController,运行中阶段回退为等待态,显示可关闭的「已取消」提示。LLM 请求超时 120s。
- 完成后:绿色摘要卡「时间线已生成 N 个片段」逐条列出(#序号、句文本、素材文件名、时长、匹配理由 reason),提示前往第 3 步;匹配 debug 显示「已使用 N/M 个素材」。
- 错误:红色 Alert 可关闭;分析/匹配失败终止流程并标红对应阶段。

### 4.3 第 3 步 · 预览调整

- 顶条:标题 + `N片段` Chip + 总时长 Chip + 口播时长 Chip(与片段总长差 >0.5s 显示 ⚠️ + 「同步」按钮:按比例缩放各段时长对齐口播)+ 操作提示 Chip「单击选中 | 拖拽排序 | 双击片段重选时段 | 双击字幕编辑」。
- 画幅/分辨率行:9:16 / 3:4 Chip 切换(全局)、1080p / 2K 切换、实时显示输出宽×高。
- 320px 宽预览框(高按画幅):
  - 时间线变化 → **300ms 防抖**自动重新 assemble 低清预览(480 宽);重合成期间**不卸载旧 video**,叠加「⟳ 更新预览…」角标,避免黑屏闪烁。
  - 字幕叠加:每段文本**按中英标点拆成单句**,句间在段内均分时长;当前播放头命中的句子显示;可**双击编辑**(Popover:文本域 + 确定/取消/删除,自动去标点显示),可拖拽定位(x/y 百分比);「字幕位置预设」一键(全部段 / 仅当前句,由 alignAll 开关控制)。
  - 安全区开关:显示三分线网格 + 中心圆点 + 5% 内缩虚线框。
  - 右下角时间码 `当前/总长`(Trim 模式下变为 `源时刻/源总长`)。
- FCP 三轨时间线(FcpTimeline):
  - T1 视频轨:每片段一块(宽∝时长,内嵌缩略图),单击选中、**拖拽重排**、**双击进入 Trim**;T2 字幕轨(只读联动,双击走同一编辑 Popover);T3 音频轨:口播与 BGM 波形(从已解码 AudioBuffer 抽峰,不重复解码)+ 音量滑杆。
  - 播放控制:播放/暂停、停止(回 0);标尺可点击/拖拽 seek。
  - 键盘:空格播放/暂停,←/→ 播放头 ±0.1s;焦点在输入控件、弹层打开、或 Trim 模式时不拦截。
- 播放实现契约:预览视频**无音轨**;口播与 BGM 用 Web Audio 独立播放(各自 GainNode 实时调音量);BGM 在结尾前 2s 线性淡出,**淡出包络必须锚定 ctx.currentTime 相对时刻**(源工程 bug 教训:锚定绝对 0 会让音乐 2-3s 后消失);停止时必须同时 pause 主 video;预览总长以真实 `<video>.duration` 为准(td/adur 可能过期)。
- Trim 重选时段(TrimEditor):
  - 双击片段进入(素材 source_duration 未知时 Snackbar 拦截「素材时长未知,无法重选时段」);Trim 期间预览框切换为**源素材实时画面**(同尺寸不跳变,主 video 保持挂载 display:none);拖动选择框(宽=槽长)实时 seek 大预览;「循环试听」开关在 [入点, 入点+槽长] 内循环播放(RAF 卡右界,越界跳回);完成/取消/ESC 退出,原样恢复合成预览;时间线整体被替换导致目标片段消失时自动退出。
- BGM 卡(右栏):内置音乐列表 + 本地导入(上传文件)+ 独立试听 + BGM 音量/口播音量滑杆。
- 封面编辑器(CoverEditor,右栏入口打开,抽屉内放大预览):
  - 选封面素材(下拉:时间线各片段缩略图 + 悬停放大预览)、截取时间滑杆 0–20s 步进 0.1。
  - 主/副标题:文本、颜色、字号(主 12–80 / 副 12–60)、斜体切换、描边颜色 + 宽度(0–8 步进 0.5)、**画布内拖拽定位**;封面画面缩放 0.2–3.0 + 拖拽平移。
  - 封面字体独立选择(FontSelect:收藏 + 最近使用);**WYSIWYG 适配**:文字超出 4% 安全区先平移、仍溢出再缩小,预览实时显示「主标题已平移/缩放适配」徽标;4% 安全区虚线框常显。
  - 封面样式预设:命名保存/加载/删除(持久化)。
- 字幕样式卡(右栏):字体(FontSelect,含收藏/最近)、颜色、字号(**语义为画面宽度百分比**)、描边颜色/宽度、字间距;「位置对齐所有段」开关。

### 4.4 第 4 步 · 导出渲染

- 摘要横幅:就绪状态(绿)/未就绪提示;就绪时列 Chips:画幅·分辨率·输出宽高、字幕 %·字体、BGM 名·音量、口播音量。
- 画幅(9:16 竖屏 / 3:4 社交)+ 分辨率(1080p / 2K)ToggleGroup,说明「自动裁切填满,无黑边不拉伸」。
- 时间线片段清单(#、句文本、素材名、起点、时长)。
- 「开始导出」大按钮 → 进度条 + 阶段文案;成功后 Alert(文件名 + 字幕/封面应用状态 + 诊断信息)、内嵌 video 预览、「查看文件」(显示路径)、「下载到本地」(Content-Disposition attachment)。
- **WYSIWYG 换算(必须照抄 ExportConfirm.tsx 的公式与注释)**:
  - `COVER_SCALE = 成片高 / 320`;封面标题在导出前用 `document.fonts.load + measureTextWidth` 按导出像素测量后走 `computeCoverFit`(shift 先、shrink 后,safeMargin 0.04)。
  - 封面描边导出 `× COVER_SCALE × 0.5`(补偿 CSS -webkit-text-stroke 居中 vs ffmpeg borderw 全外侧);**字幕描边不乘 0.5**,按 `× 导出宽 / 320` 缩放;字幕字号 `= size% × 导出宽`。
  - 封面平移 offset 在 API 边界取负并 × COVER_SCALE(预览坐标系与后端裁切窗坐标系方向相反)。
- 分辨率语义:1080p → 宽 1080;2K → 宽 1440;高 = 宽 × 画幅比(9:16 → 1080×1920 / 1440×2560;3:4 → 1080×1440 / 1440×1920)。

---

## 五、实现逻辑规格(后端管线)

> 全部以源工程行为为准,以下为契约摘要 + 关键参数。所有端点响应统一 `{ code, message, data }`,`code === 0` 成功(保持,便于对照移植)。

### 5.1 analyze-script(文案分析)

- LLM 单次调用,提示词**原样照搬** `ai_service.py::analyze_script`:按语义自然断句拆 **5-8 段**,每段给 text、keywords(3-5 个画面关键词)、duration_hint(仅上下文参考,明确告知不要臆测精确时长)。temperature 0.3,max_tokens 1000。
- JSON 提取容错(```json 块/裸 JSON)+ 段数不足 3 时按标点强拆(`_force_split_segments`)。

### 5.2 场景检测(素材 → 场景)

- `ffprobe` 优先取时长(format=duration,120s 超时),失败回退 ffmpeg 全解码解析 `Duration:` 行。
- 场景切割:`ffmpeg -i <in> -vf "select='gt(scene,threshold/100)',metadata=print:file=-" -f null -`。
- **红线:场景时间戳解析必须同时扫 stdout + stderr**(`metadata=print:file=-` 在部分构建输出到 stdout;只扫 stderr 会让整段视频塌成 1 个场景且无报错——源工程查了几个月的坑)。
- 忽略 t ≤ 0.1s 的切点;首尾补 0 与总时长;合并短于 min_duration 的场景。输出 `[{index,start,end,duration,isHook:false}]`。
- 默认参数:`AI_SCENE_THRESHOLD = 20.0`(即 gt(scene,0.20)),`AI_MIN_SCENE_DURATION = 0.3s`。
- 抽帧:每场景在 `start + duration×0.3` 处抽 1 帧(`-ss <t> -i <in> -vframes 1 -q:v 3 -threads 1`),抽帧并发用信号量限制。

### 5.3 analyze-video(场景视觉描述)

- 每帧一条 vision 调用,提示词:`简要描述这个视频画面的内容(1-2句话):{上下文}`,max_tokens 500;**并发信号量 5**(`MASHUP_VISION_CONCURRENT`),带指数退避重试,单帧失败落 `[分析失败] ...` 占位不中断。
- **场景描述缓存**:键 = `md5(视频路径 + mtime + 帧序号 + prompt)`,素材未变重跑免费命中(落 `storage/mixcut/cache/scene-cache/`)。
- creative-studio 实现:走 `lib/script-providers` 的 `completeJson`/多模态通道(参考 `lib/final-edit/adapters/video-analysis.ts` 的 images 用法),vision 模型用项目已配置的多模态 provider。

### 5.4 split-tts(分句 TTS,时长唯一基准)

- 输入 segments 文本数组 + voice + speed;输出 `{ audio_path, total_duration, seg_durations[] }`(每句真实秒数,顺序与 segments 一致)。
- creative-studio 实现:直接用 `lib/final-edit/adapters/tts-registry.ts` 的 vapi-qwen3-tts(`synthesize` 已返回 segmentTimings,微秒 → 秒换算即可);音频落 `storage/mixcut/<projectId>/tts/`。
- TTS 缓存沿用现有 adapter 的缓存机制;每次成功生成后端覆盖同路径时,前端靠 audioVersion 强制刷新。
- 试听端点(preview-voice):短文本样本合成直接回流(移植源工程语义;「测试连接」按钮复用该端点)。

### 5.5 detect-beats(口播气口)

- `ffmpeg -i <audio> -af silencedetect=noise=-35dB:d=0.20 -f null -`,解析 stderr 的 silence_start/silence_end(含 silence_duration、noise_level),**气口 = 每段静音的中心时刻**;只有 end 没有 start 的开头静音也算。
- 无静音/失败 → 均匀 fallback:总长分 8 段取内部 7 个切点,`fallback: true`(前端收到 fallback 就**不用**这些点)。
- **红线:`-i` 输入路径不做 drawtext 式转义**(`C\:/...` 会让 ffmpeg 报 Invalid argument)。

### 5.6 match-scenes-v2(音频优先匹配,核心)

编排(`ai_service.py::match_scenes_audio_first`):

1. **LLM 打分矩阵**(单次调用,提示词照搬 `_llm_score_matrix`):产出 `score_matrix[n句][m素材]`(0-1)+ `hook_scores[m]`(开场钩子吸引力,同一通调用多问一句零额外成本)。temperature 0.2,max_tokens 1500。失败回退全 0.6 均匀矩阵 + 零钩子分(流程不断)。
2. 手动 `isHook` 素材强制 hook=1.0 覆盖 LLM 分。
3. **MatchSolver 求解**(`match_solver.py`,**逐行翻译为 TS**):
   - 建模:S → 句(容量1) → 场景(容量1) → 视频(按源视频路径聚合) → T;视频→T 用 **副本边递增加价**(第 k 次使用成本 λ×(k-1))实现全局最优去重;最小费用流用带势 Dijkstra(Johnson),初始势 `_POT_INIT = 2.0`,地板外重罚 `_BIG = 1000`。
   - 硬约束:①分配素材 `available ≥ 该句时长`;②`start + duration ≤ scene.end`;构造上保证 `Σduration == Σseg_durations`。
   - 语义地板:`max(semantic_floor_abs, red_line, best_eff × (1 − semantic_floor_rel))`,地板外只在无可选时勉强用并标记 backoff;开场段(i==0)有效分 `+= hook_weight × hook[j]`。
   - 无长度可行候选 → 局部回退取「有效分 − λ×已用次数」最高者,feasible=False。
   - 节拍吸附:每个气口找最近切点,偏移 ≤ 0.2s 且相邻两段 ±Δ 后仍满足各自边界与最短段长才生效(**Σduration 不变**)。
   - 结果每项:`segment_index / video_path / start_time / duration / source_duration / used_scene_index / reason(score=x.xx 语义首选|覆盖优先|语义降级(兜底)(第N次使用)) / snapped_beat / segment_text`。
   - 不变量校验:总长差 < 1e-3、逐段边界;返回 debug:`used_materials/total_materials/feasible/red_line/coverage_penalty/candidate_window/backoff_segments`。

### 5.7 preview/assemble(低清快拼)

- 输入 timeline(video_path/start_time/duration)+ 预览尺寸(**宽 480**,高按画幅取偶)+ aspect;各段裁切拼接为无声低清 mp4,**按参数缓存**(同 key 秒回,第 2 步完成时预热就是打这个缓存)。落 `storage/mixcut/<projectId>/previews/`。

### 5.8 composite(成片合成)

顺序(`ai_editing.py::composite_endpoint` + `video_service.py::composite_clip`):

1. 口播音频:优先复用 split-tts 的 `audio_path`(**V1 流程必须传,不再重新 TTS**);无则重新合成。
2. 逐段 trim:`-i <src> -ss <start> -t <dur> -vf "scale=W:H:force_original_aspect_ratio=increase,crop=W:H,setsar=1" -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -an`;失败段跳过不中断。
3. concat demuxer 拼接(列表文件 **UTF-8**、路径反斜杠归一为 `/`)。
4. 口播混音:`-t audio_dur` 对齐;**若视频比音频短 0.1s 以上,先 `tpad=stop_mode=add:stop_duration=<差>` 补最后一帧**(结尾冻结 bug 的治本修复,必须保留);`-vf` 必须放在所有 `-i` 之后。
5. 字幕烧录(`_render_subtitles`):drawtext 滤镜链,**每段内按标点拆单句均分时长**逐句 drawtext;字体文件拷贝到 ASCII 安全临时路径(CJK 路径会翻车);**drawtext 文本必须转义** `: % { } ' \`(照搬 `_escape_drawtext`);字号/描边/颜色/坐标(x/y 百分比,含每段 override)。
6. 封面:`render_cover` 用封面素材某帧 + zoom/offset(纯拉伸 `scale=W*zoom:H*zoom` + `crop=W:H` + 裁切窗偏移)+ 标题/副标题 drawtext(斜体用 FreeType 变换),生成约 1s(具体时长以源码为准)封面段**前置拼接**到成片;封面失败不毁成片,仅在响应 `_diag.cover_error` 报告。
7. BGM 混音:BGM 音量 + 口播音量、循环补齐、结尾淡出(具体滤镜以 `ai_editing.py` composite 后半段为准),`_bgm_mix.log` 式关键日志保留(写入 mixcut 日志)。
8. 响应带 `subtitle_applied / cover_applied / _diag`(n_segs、has_text、has_subtitle_style、cover_condition、cover_error 等)——前端成功提示直接展示,**这套诊断字段是排障生命线,不许省**。
- creative-studio 实现:composite 作为**队列 job**(复用现有 final-edit-jobs 模式)提供进度轮询;完成后产物登记到项目资产,可进导出 ZIP。落 `storage/mixcut/<projectId>/exports/`。

### 5.9 关键默认参数表(照搬,不许拍脑袋改)

| 参数 | 值 | 出处 |
|---|---|---|
| 场景切换阈值 | 20.0(→0.20) | config.py AI_SCENE_THRESHOLD |
| 最短场景时长 | 0.3s | config.py AI_MIN_SCENE_DURATION |
| vision 并发 | 5 | MASHUP_VISION_CONCURRENT |
| 前端素材分析并发 | 5/批 | AiScriptEditor runBatched |
| LLM 前端超时 | 120s | AiScriptEditor LLM_TIMEOUT |
| TTS 失败估算 | 0.22s/字,下限 1.0s | AiScriptEditor estimateSegDurations |
| red_line | 0.35 | match_solver |
| coverage_penalty λ | 0.15 | match_solver |
| candidate_window | 0.10 | match_solver |
| min_segment_duration | 0.2s | match_solver |
| hook_weight | 0.2 | match_solver |
| semantic_floor_abs / rel | 0.3 / 0.15 | match_solver |
| 节拍吸附容差 | ±0.2s | match_solver._snap_beats |
| silencedetect | noise −35dB,d 0.20s | beat_detect |
| 均匀切点 fallback | 8 段 7 点 | beat_detect |
| 预览宽 | 480 | editing-store computePreviewDims |
| 预览 assemble 防抖 | 300ms | fcpTimelineConfig |
| 分辨率宽 | 1080p→1080,2K→1440 | editing-store |
| 封面安全区 | 4% | coverFit safeMargin |
| BGM 尾部淡出 | 2s | TimelineEditor play() |

---

## 六、creative-studio 落地决策

### 6.1 复用(不重写)

- `lib/ffmpeg.ts`(二进制解析:env → ffmpeg-static → PATH,双平台已打包)。
- `lib/script-providers/`:所有 LLM 文本/vision 调用(completeJson + images)。
- `lib/final-edit/adapters/tts-registry.ts` + `vapi-qwen-tts.ts`:split-tts 与试听。
- `lib/final-edit/heavy-job-lock.ts`、final-edit-jobs 队列模式:composite job。
- `lib/final-edit/storage-path.ts` 的安全路径解析思路(媒体服务端点必须做 realpath + 扩展名白名单 + 根目录约束,对应源工程 `_is_safe_path` 红线)。
- `lib/data-root.ts`、SQLite(`lib/db.ts` + `CORE_DB_MIGRATIONS` 追加)。

### 6.2 新建模块(建议布局)

```
lib/mixcut/
  types.ts            # Segment/Scene/TimelineItem/MixcutSession/样式与封面草稿类型
  scene-detect.ts     # §5.2(含 ffprobe 时长、stdout+stderr 解析)
  frame-extract.ts    # 抽帧 + 并发信号量
  vision-describe.ts  # §5.3 + scene-cache
  script-analyze.ts   # §5.1
  split-tts.ts        # §5.4(桥接 tts-registry)
  beat-detect.ts      # §5.5
  match-solver.ts     # §5.6 逐行翻译(含 _MinCostFlow)
  match-orchestrate.ts# §5.6 编排(矩阵→solver→debug)
  preview-assemble.ts # §5.7(含缓存)
  composite.ts        # §5.8(trim/concat/mix/tpad/subtitle/cover/bgm)
  drawtext.ts         # 转义 + 字体安全拷贝
  cover-render.ts     # render_cover 翻译
  fonts.ts            # 系统字体扫描(mac: /System/Library/Fonts,/Library/Fonts,~/Library/Fonts;win: C:/Windows/Fonts)
  session-store.ts    # mixcut_sessions 读写(SQLite)
app/api/mixcut/       # 端点一一对应:analyze-script/analyze-video/split-tts/detect-beats/
                      # match-scenes-v2/preview-assemble/composite(job)/voices/preview-voice/
                      # fonts/font-file/music(list,import,stream)/media(video,audio,thumb)/session
components/mixcut/    # AppShell/四步组件/FcpTimeline/TrimEditor/CoverEditor/FontSelect/...
                      # (CSS Modules;文件划分可参照源工程组件树)
```

### 6.3 UI 技术

React 19 + CSS Modules。MUI 组件对应:Popover/Snackbar/Autocomplete/Slider/Chip 等用现有项目内已有控件或轻量自实现;不引第三方 UI 库。`coverFit.ts`、`waveformPeaks.ts` 为纯逻辑,近原样翻译。字体预览 @font-face:**.ttc 跳过**(浏览器不支持,与源工程一致,靠 CSS font-family 回退);非 .ttc 用 blob URL 注入并 `document.fonts.load` 后重绘。

### 6.4 API Key 与模型(与源工程的刻意差异)

源工程在右栏 UI 明文输入分析 Key / TTS Key。creative-studio 惯例是服务端配置(`.env.local` + provider 配置)。移植为:右栏改成「模型/服务商选择面板」——分析模型下拉(列项目已配置的 script-providers,含 vision 能力标注)、TTS 服务商下拉(tts-registry 列表)、保留「测试连接」「试听」按钮(打服务端配置的 Key)。**Key 缺失时的软校验交互保留**:提示红字 + 滚动到该面板,文案改为「请先在设置中配置 ×× 服务商」。

### 6.5 素材池数据源

- 自动:当前项目 `video` 阶段已完成的视频任务产物(参照现有 `FinalEditAssetPool.tsx` 取数路径)进池,status=ready,来源标记「项目素材」。
- 手动:外部文件导入走上传端点存 `storage/mixcut/<projectId>/materials/`,probe 用 ffprobe,缩略图用抽帧;来源标记「外部导入」。
- validate/probe/thumbnail 三端点语义照搬 `routes/materials.py`。

### 6.6 状态持久化

- 新 SQLite 表 `mixcut_sessions`(project_id 唯一, state_json, updated_at):存 editing-store + materials-store 形状的会话状态(时间线、字幕样式与 overrides、封面草稿、BGM、音色/语速、画幅/分辨率、素材清单)。防抖自动保存;进入第五步时恢复——对应源工程 localStorage persist + ProjectHistory 两层语义的合并。
- **不持久化**:运行中的分析/渲染轮询状态(源工程铁律:persist 会复活僵尸 processing 任务)。job 状态一律以队列表实时查询为准。
- 迁移走 `CORE_DB_MIGRATIONS` 追加 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`(沿用 try/catch 幂等约定)。

### 6.7 与旧 final-edit 的关系

- 阶段 0–4 期间新模块在独立路径开发,旧 final-edit 保持可用。
- 阶段 5 把 `app/projects/[id]/page.tsx` 的 `final-edit` tab 内容换成新 `MixcutPanel`(tab id 可保留 `final-edit` 以免动 WORKBENCH_TABS 序列化),随后删除不再被引用的旧 UI 组件与编排逻辑(`components/final-edit/` 大部分、`lib/final-edit/proposal.ts`/`workspace.ts` 等编排层),**保留被 §6.1 复用的 adapters/ffmpeg/队列底座**(按依赖图裁剪,删前跑全部测试)。
- 旧 final-edit 的 WIP 已存档提交(`6ed04d1` "Archive final edit WIP before mixcut port",分支 `mixcut01`),工作树干净,移植提交不混入旧改动。需要参考旧实现时直接看该提交即可。

---

## 七、分阶段执行计划

> 每阶段结束:跑该阶段测试 + `npm run lint` + `npm run build`;测试按仓库惯例写 `scripts/mixcut-*.test.ts`,`node scripts/<file>` 直跑。阶段内自查对照源文件,不确定的行为**以源码为准,不猜**。

### 阶段 0:骨架 + 数据模型 + 素材池(第 1 步可用)

- 建 `lib/mixcut/types.ts`、`session-store.ts`、DB 迁移、`app/api/mixcut/session` 与 materials 三端点、素材上传/缩略图/媒体服务(含路径安全校验)。
- `components/mixcut/` 壳(AppShell + 四步常驻挂载 + 面板折叠拖宽持久化)+ 第 1 步全部交互(§4.1)。
- **验收**:项目素材自动进池;拖拽导入外部视频出现占位 → 就绪(元数据+缩略图正确);筛选/多选/详情/删除全通;刷新页面素材池与布局恢复;`mixcut-session.test.ts`、`mixcut-materials.test.ts` 绿。

### 阶段 1:管线后端(纯逻辑,先于 UI)

- `scene-detect / frame-extract / vision-describe / script-analyze / split-tts / beat-detect / match-solver / match-orchestrate` 全部落地 + 对应 API 端点。
- **match-solver 行为对拍(硬性)**:构造 ≥5 组固定输入(含:素材充足零重复、素材不足最少重复、语义地板兜底、开场钩子偏好、节拍吸附边界拒绝),先用源工程 Python 跑出期望输出存 fixture,TS 实现必须逐字段一致(`mixcut-match-solver.test.ts`)。
- 场景检测用仓库内生成的硬切测试视频验证(源工程手法:H.264 小片段两场景 `[(0,2),(2,4)]`),同时验证 stdout/stderr 双扫。
- **验收**:各端点单测绿;`Σtimeline.duration == total_duration` 误差 ≤ 0.04s;每段 `start+dur ≤ source_duration`;vision 缓存二跑零 LLM 调用。

### 阶段 2:第 2 步 UI + 编排

- §4.2 全量:文案卡、音色卡(动态列表/试听/语速)、四阶段进度(并行编排/取消/TTS 降级/预热)、结果摘要。
- **验收**:真实素材端到端跑通出时间线;取消后可重跑;拔掉 TTS 配置仍能以估算时长出时间线并正确提示;进度条/耗时/阶段消息与源工程行为一致。

### 阶段 3:第 3 步预览调整

- preview-assemble(缓存+防抖)+ 320 预览 + 字幕逐句叠加/编辑/拖拽/预设 + Web Audio 混音(增益实时、BGM 淡出锚定、停止全停)+ FcpTimeline 三轨(重排/选中/波形/快捷键)+ TrimEditor + BGM 卡 + 同步按钮。
- **验收**:改时间线 300ms 内仅一次 assemble;重排/Trim 后预览与时长徽标即时正确;空格/箭头快捷键含守卫;BGM 全程不消失且尾部 2s 淡出;Trim 循环试听正确卡界;对照 §4.3 每条交互逐项过。

### 阶段 4:封面编辑器 + 第 4 步导出

- CoverEditor(WYSIWYG fit + 预设)+ ExportConfirm(全部换算公式)+ composite job 全链(§5.8)+ 下载/预览。
- **验收(WYSIWYG 硬标准)**:同一封面在步骤 3 预览与导出成片首帧上,标题位置/字号/描边视觉一致(截图对比);字幕字号与描边随分辨率等比;9:16 与 3:4、1080p 与 2K 四组合各出一片;成片时长 == 口播音频时长(±0.04s),结尾无冻结;BGM/口播音量比正确;封面失败时成片仍产出且诊断可见。

### 阶段 5:替换与清理

- 换挂载点、按依赖图删除旧 final-edit 不再使用的部分、更新 CLAUDE.md 模块说明、全测试套 + 双平台打包脚本的断言检查(安装包不得混入 `storage/mixcut` 数据目录 → 加进 prune 清单)。
- **验收**:第五步 tab 即新混剪;全仓测试绿;`npm run build` 通过;grep 无对已删除模块的悬空引用。

### 阶段 B(另启会话,验收后)

批量生产向导(5 阶段 + 阶段机 + 断点恢复 + 播放器式控制)、豆包 TTS 适配器、(可选)模板模块。启动前重读源工程 `批量分析_最优迭代方案.md` 与 `batch.py`。

---

## 八、红线与硬坑清单(执行时违反任何一条都算失败)

源工程用几个月踩出来的教训,原样继承:

1. **事件循环/主线程不阻塞**:所有 ffmpeg/ffprobe 子进程调用在 Node 侧必须异步(spawn + promise),长任务走队列;绝不在请求处理里同步等重活(源工程曾因一处同步调用全站假死)。
2. **场景时间戳双扫 stdout + stderr**(§5.2)。
3. **`-skip_frame nokey` / `-lowres` 是输入选项,必须在 `-i` 之前**(本次单条流程默认不启用,但翻译 detect 函数时保留形参与位置约定,阶段 B 要用);**HEVC 不支持 `-lowres`**,仅 codec_name=="h264" 启用。
4. **drawtext/subtitles 文本必须转义** `: % { } ' \`;**字体文件拷到 ASCII 安全路径**再喂 fontfile。
5. **`-i` 输入路径永不做 filter 式转义**;filter 内路径(fontfile 等)才转义。
6. **媒体/字体/文件服务端点必须做路径安全校验**(realpath + 扩展名白名单 + 必须落在 storage 根内),不信任任何客户端路径。
7. **文件上传不能走 JSON 序列化的封装**(源工程 api.post 把 FormData 序列化成 `{}` 的坑)——上传用原生 fetch + FormData / Next.js formData()。
8. **concat 列表文件 UTF-8 + 路径正斜杠**(中文文件名)。
9. **视频短于音频先 tpad 再 `-t`**(结尾冻结治本);`-vf` 放全部 `-i` 之后。
10. **BGM 淡出包络锚定播放起始的 ctx.currentTime**;停止播放必须同时停 video 与全部 AudioBufferSource。
11. **步骤组件常驻挂载**,display 切换;**运行态(轮询/进度)不持久化**。
12. 大依赖数组的导出/运行回调(handleRun/handleExport)新增样式字段时必须同步更新依赖,否则闭包过期——移植时优先用 store 直读(zustand→自选状态方案)规避整类问题。
13. 平台差异:源工程默认字体路径全是 Windows(`C:/Windows/Fonts/msyh.ttc`);mac 上字体扫描与回退链必须给 PingFang/Hiragino 等等价物,任何硬编码 Windows 路径都要抽成平台分支。
14. 本项目约定:不 commit `.env.local`;`data/`、`storage/` 不进安装包;UI 语言中文。

---

## 九、最终验收(全部完成后跑一遍)

1. 端到端:7 个 ~5s 素材 + 150 字口播 → 一键出 15s 级成片;成片时长 == 口播时长 ±0.04s;结尾无冻结无黑场;素材使用数 ≥ 5/7 且 debug 可见。
2. 交互对照:开两个屏,源工程(`npm run dev`,浏览器 5173)与新实现并排,按 §四 逐条过——差异要么是本文档明示的刻意差异(§6.4 等),要么修掉。
3. 降级链:TTS 失败→估算时长无配音成片;LLM 打分失败→均匀矩阵成片;封面失败→成片照出+诊断;节拍 fallback→不吸附。
4. 刷新/重启恢复:会话状态(素材、时间线、样式、封面、BGM)完整恢复;运行态不复活。
5. `npm run lint`、`npm run build`、全部 `scripts/mixcut-*.test.ts` 与存量测试绿;mac 打包脚本跑通且安装包断言无泄漏。

---

## 十、开放问题(执行中遇到再问主理人,其余不要问)

1. ~~旧 final-edit 未提交改动处置~~ **已解决**:已存档为 `6ed04d1`(见 §6.7)。
2. ~~阶段 B 优先级~~ **已解决**:主理人验证的是单条精细模式,阶段 B 维持后置(见 §二)。
3. 音色体系:vapi-qwen3-tts 的音色集与源工程 qwen 音色集不完全一致,精选 12 卡的关键词清单需按实际列表微调(交互不变)。
4. 16:9 预设是否保留为第三画幅(现有 final-edit 支持,源工程只有 9:16 / 3:4;默认:保留但不作为主交互)。
