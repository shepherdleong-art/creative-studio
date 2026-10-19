# 包装融入预览调整 · 设计文档（2026-09-18 与用户逐节确认 + 深度自查修正）

> 前置文档：`HyperFrames包装层集成-执行文档-v1.md`（§12/§13 v4 定稿）、`HyperFrames包装层集成-交接执行文档-v2.md`（§7–§10 v3/v3.1–v3.3）。
> 本文档已经用户逐节确认（布局/封面、卖点编辑、数据与落地、补充优化），并经一轮代码级深度自查修正（§9 时间基准 bug 为用户确认的修复项），勿再反问。

## 1. 背景：用户反馈的 4 个问题 + 自查实锤 1 个既有 bug

| # | 问题 | 已定方案 |
|---|---|---|
| ① | 实时预览修改封面字体/卖点后看不到封面，要切模板再切回来才能抢 1 秒看到 | 包装层透明 iframe 直接叠加到「预览调整」的预览窗口，与播放头同步；配置变更重载后自动 seek 回当前播放头——播放头停在封面段时封面**常挂**，改即所见 |
| ② | 卖点标签要能自由挪动大小和位置 | 封面+正片卖点均可在预览画面里直接拖拽/角点等比缩放；布局按模板分别记忆；同源 iframe 内直接拖真实模板 DOM（预览=成片） |
| ③ | 正片卖点标签文字要能改 | 时间线新增「卖点」轨：文字、时间、增删全可在轨上操作 |
| ④ | 包装渲染阶段仍弹大量黑色 CMD 窗口（老问题复发） | 全链路 spawn 审计 + 本机复现监控进程创建定位 + 统一 spawn 入口强制 windowsHide 防回归 |
| ⑤（自查实锤） | **pointCues 时间基准既有 bug**：对齐用字幕/词时间戳（口播时间）直接当成片时间轴用，弹出系统性提前 0.83s（倍速=1），倍速≠1 还有速率误差。证据：`packaging-cues.ts` 未做换算，renderer.ts:155 字幕正确换算为 `片头 + 字幕秒/倍速`；DB 组 bf3fe8a4「云气垫公仔棉」字幕 3.74s、cue 存 3.97s，正确应为 4.57s | 提取时统一换算 `成片秒 = coverSec + 口播秒/倍速`（见 §9）；存量组经 key 版本盐自动重提取一次 |

**需求形态变更（用户主动提出）**：取消独立「视频包装」步骤，融入「预览调整」界面——封面与卖点直接共用预览调整的预览窗口；卖点进入时间线（含增删）；原「视频封面设置」抽屉保留选帧功能、主副标题改为**点选启用**（默认折叠不使用）。

工作流变为 4 步：**素材 → 智能创作 → 预览调整（含包装）→ 导出渲染**。

## 2. 界面布局

```
┌ 素材替换列 ┐┌──────────── 主区 ────────────┐┌──── 右栏卡片 ────┐
│           ││ 工具行（下一步：导出）        ││ ▣ 视频包装(新)    │
│           ││ ┌──────────────────────┐    ││   启用开关        │
│           ││ │ 预览窗口              │    ││   模板 2×2        │
│           ││ │ = 视频画面            │    ││   主/副标题字体    │
│           ││ │ + 包装层(透明iframe) │    ││   卖点字体+上传    │
│           ││ │ 同步播放/暂停/seek   │    ││   标题/副标题文案  │
│           ││ └──────────────────────┘    ││   封面卖点1-3文案  │
│           ││ 时间线：视频|字幕|卖点(新)|音频││   [跳到封面]      │
└───────────┘└─────────────────────────────┘│   [恢复默认版式]  │
                                             │   [重新提取卖点]  │
                                             │ ▣ 字幕样式        │
                                             │ ▣ 背景音乐        │
                                             │ ▣ 口播变速        │
                                             │ ▣ 视频封面设置    │
                                             └──────────────────┘
```

- 右栏新增「视频包装」卡放**最上方**：启用开关、模板 2×2 选择、三槽 FontPicker（卖点槽保留「上传字体」入口）、标题/副标题/封面卖点 1-3 文案表单、「跳到封面」「恢复默认版式」「重新提取卖点」按钮。
- **MixcutPanel 改动涟漪点**：STEPS 数组改 4 步、`stepOverviews` 同步、`stepDisabled` 索引前移、PreviewStep `onExport` 直接跳导出步；`PackagingStep.tsx` 删除，其功能迁入新包装卡组件；**CSS 类（pk*/tpl*）迁入新卡片样式，勿整段删**。
- **写操作通道**：包装卡所有写操作（配置/文案/字体/布局/卖点增删改）复用 PreviewStep 现有 `applyGroup` 串行队列（`set_packaging_config` 走 GroupCommandInput），与字幕/片段编辑共用 revision 乐观锁，防并发冲突。
- ExportStep 不变（两阶段进度 + 失败兜底沿用）。

## 3. 包装预览叠加层（解决问题①的核心）

- **叠加**：同源透明 iframe（`/api/final-edit-groups/[id]/packaging-preview?format=html&sync=1&edit=1`）`position:absolute; inset:0` 盖在 `FinalEditPreview` 的 `.previewStage`（已验证 `position:relative; overflow:hidden`，可直接承载）；默认 `pointer-events:none`，不挡视频交互。角标/安全区保持在上层可见（z-index 微调）。
- **`&sync=1` 抑制自动播放**：现有路由无 t 时 80ms 后自动 `play(0)`、有 t 时 `pause+seek`——合并后时间轴 100% 由父页面驱动，该参数让路由**完全跳过 autoplay 脚本**，消除「父页面 seek 后被 autoplay 抢走」的闪跳。
- **同步**：同源直取 `iframe.contentWindow.__timelines['overlay']`（模板必注册的 GSAP 时间轴，免 postMessage）：
  - 暂停/seek：`timeline.time(playheadSec)` 精确到帧；
  - 播放：`timeline.play(from playheadSec)` 独立走，每 0.5s 漂移校正（|Δ|>0.08s 则 `time()` 校准）；标签页隐藏恢复时重校准。
- **重载规则**：模板/三槽字体/文案/草稿切换 → iframe 重载，`load` 事件后自动 seek 回当前播放头并恢复编辑态。**播放头在封面段时封面常挂**——改字体/改卖点即时可见，无需抢时间，解决问题①。（布局保存**不**触发重载：拖拽已把 DOM 改为目标态，见 §6。）
- 「跳到封面」按钮 = seek 到封面段中点（coverSec/2）并暂停，解决封面段仅 ~0.83s 进度条难拖准的问题。
- **播放链路**：播放/暂停/进度条全部沿用 `FinalEditPreview` 现有播放条（AudioContext 时钟），包装层纯跟随，不引入第二套播放控制。
- **iframe ready 队列**：seek/play 指令在 `load` 前入队，`load` 后统一执行。
- **包装关闭时**：叠加层与卖点轨整体隐藏，界面零干扰。
- 预览仍注明「近似效果，最终以导出渲染为准」。

## 4. 封面设置融合（CoverEditorDrawer 改造）

- **保留**：来源片段选择 + 截帧时间滑杆 + 画面缩放/水平/垂直滑杆（即封面画面选择）；选完预览窗口封面段立即可见。
- **主/副标题改为点选启用**：抽屉加「启用封面标题」勾选（**默认关闭**），勾选后展开原有全部标题编辑（文字/字体/颜色/描边/斜体/预设）。
  - 开关存 `coverTitleJson.enabled`（JSON 内加字段，零迁移；旧数据无此字段按「有标题文字则视为启用」迁移兼容，避免老项目标题凭空消失）；`CoverEditorDraft` 增加 `enabled`，`apply_cover_editor` 命令透传。
  - **渲染端开关位置（已核实）**：封面标题经 overlay bundle 的 `title.png` 合成进封面与片头（renderer.ts:117）；开关 = renderer 按快照冻结的标志**跳过 title.png 合成**（bundle 生成照跑不碍事）；FinalEditPreview 片头 overlay、右栏封面缩略图同步读开关。关闭即不画标题，避免与包装封面双标题。
- 包装封面（标题/副标题/卖点/装饰）在预览窗口封面段直接可见可拖（§6），文案在右栏包装卡改。

## 5. 卖点时间线轨（解决问题③）

`MixcutTimeline` 在字幕轨与音频轨之间新增「卖点」轨（标签列同步加「卖点」标签，轨道高 28px 同字幕轨）。

- **时间口径（配合 §9 修正后）**：`pointCues.startSec/endSec` 本身即**成片时间轴秒**，轨上位置直接 `秒 × pxPerSecond`（与视频轨同原点），与字幕轨（`INTRO + 字幕秒/倍速`）自然对齐——修复后卖点块正好落在对应字幕上方，误差 <0.2s。
- **单击**选中 → 预览 seek 到 `(start+end)/2`（弹出中间时刻，避开入场动画）并暂停，预览里该标签同步高亮；
- **双击**就地改文字；**拖动**改弹出时间；**两侧修剪**改时长（**最小 1.2s**＝模板 MIN_DISPLAY_SEC、不出界）；**右键**删除；
- 工具行「**+ 卖点**」：在播放头处新增（起点钳制 `max(播放头, coverSec)`——封面段内不能加正片卖点；默认时长 2s；默认文字智能取当前播放头字幕句截 ≤14 字，取不到为「新卖点」）；
- 交互与现有字幕块一致（分割工具对本轨不生效）；右键菜单 kind 扩展 `point`。
- **视觉区分（用户「视觉分离」要求）**：卖点块用模板主题色系 + 🏷 图标，与字幕块明显不同，防误认。
- 手动移动后的卖点不再与字幕联动（字幕改动不带动卖点），界面一次性提示。
- 空轨引导：包装已启用且无卖点时轨内显示「点 +卖点 添加」。

## 6. 预览画面拖拽/缩放编辑（解决问题②）

**编辑域视觉分离（用户明确要求）**：
- 播放头在**封面段** → 仅封面 3 条卖点（`point1-3`）显示拖拽框；文案在右栏表单改。
- 时间线**选中正片卖点** → 仅该条卖点标签显示拖拽框；文字在轨上改。
- 预览角标本就显示「封面」/「片段 N」，天然标明当前编辑域；看到什么才能拖什么，不会误调。

**交互**：
- 拖拽框：按住移动（% 坐标）、四角拖拽**等比缩放**（相对模板默认的倍率）、单条「↺ 复位」小按钮；边界钳制不拖出画布；**拖拽中显示实时 坐标%/缩放% tooltip**（精调可控）。
- 模板元素加 `data-point-id` 钩子：封面 `cover:point1..3`，正片 `cue:<cueId>`；四套模板统一。
- 实现：预览路由 `&edit=1` 注入编辑桥脚本（同源 iframe，父页面直接操控 DOM），拖完换算画布百分比回传父页面，经 §2 的 applyGroup 队列防抖写 `set_packaging_config`。
- **拖拽期间 iframe 零重载**（只改 DOM，后台静默保存），保证流畅。
- `pointer-events`：非编辑态 `none`；进入编辑态 `auto`；ESC/点空白处退出编辑态。
- 布局**按模板分别记忆**（不按画幅分别记忆——坐标为百分比自适应，已知取舍）；右栏「恢复默认版式」一键清除当前模板全部手动布局。

## 7. 数据模型（packagingJson 扩展，JSON 文本零迁移）

```json
{
  "enabled": true, "template": "overlay-poster",
  "varsOverrides": { "title": "...", "subtitle": "...", "point1": "...", "point2": "...", "point3": "..." },
  "titleFont": null, "subtitleFont": null, "pointFont": null,
  "pointCues": [{ "id": "p_x7ab", "text": "100%全实木", "startSec": 4.2, "endSec": 6.1 }],
  "pointCuesKey": "<narrationHash+版本盐>",
  "pointCuesEdited": false,
  "layouts": {
    "overlay-poster": {
      "cover": { "point1": { "x": 12, "y": 68, "scale": 1.1 } },
      "cues":  { "p_x7ab": { "x": 30, "y": 40, "scale": 0.9 } }
    }
  }
}
```

- `pointCues` 每条加稳定 `id`（nanoid）：**存量无 id 数据读取时回填**；自动重提取时按「规范化文本」匹配保留旧 id，保住用户已调好的布局（§6 的 `cue:<id>` 键不失联）。
- `layouts` 坐标为画布百分比，scale 为相对倍率。**清理规则**：删除卖点 → 同步删其 `layouts.*.cues[id]`；重新提取 → 清空当前模板 `layouts.cues`（封面 cover 布局保留）；换模板互不影响。
- **封面卖点文案（varsOverrides.point1-3）与正片卖点文案（pointCues）保持两套独立数据**（用户明确决策），各自编辑互不影响。
- `parsePackagingConfig` 向后兼容旧数据（缺字段给默认）；`set_packaging_config` 扩展透传 pointCues 增删改/layouts。
- **手动编辑保护**：任何 pointCues 手动变更置 `pointCuesEdited=true`，此后口播哈希变化不再自动重提取；预览 JSON 增加 `pointCuesStale` 标志（服务端比对 pointCuesKey 与当前口播哈希），界面提示「口播已变化，可重新提取」；「重新提取卖点」复位为自动（清空 Edited 与 layouts.cues，按新哈希重提取）。
- `enqueueRender` 把 layouts/pointCues/pointCuesEdited 冻结进渲染快照（导出期间继续调整不影响本次任务）。

## 8. 渲染联动（管线与模板）

- `package-video.mjs` 把 `layouts` 写入 vars.json（`window.__vars.layouts`）。
- 四套模板统一改造：
  1. 封面/动态卖点元素渲染时写 `data-point-id`；
  2. **执行时机**：元素创建后、首帧渲染前（模板初始化末尾、`window.__timelines['overlay']` 注册完成前）执行统一 `applyLayouts(layouts?.[templateId])`：按 `data-point-id` 匹配，覆盖 `left/top`（%）并在原 transform 上乘 scale；无覆盖走模板默认版式。
- 预览与成片同一模板代码路径，所见即所得。
- 模板目录运行时读取即生效；app 侧改动需 `npm run build` + `robocopy /MIR` 同步 standalone。

## 9. pointCues 时间基准修正（自查实锤的既有 bug）

- **现状（错）**：`buildPointCues` 对齐得口播时间（wordTimings/subtitleCues 的 startUs/1e6），`postProcessTimedCues` 直接当成片时间轴钳制；`ensurePackagingPointCues` 的 totalSec 也未除倍速。
- **正确换算（以 renderer.ts:155 字幕为准）**：`成片秒 = coverSec + 口播秒 / playbackRate`。
- **修法**：`buildPointCues` 输入增加 `narrationPlaybackRate`，对齐后、后处理前统一换算为成片时间轴秒；`ensurePackagingPointCues` 读 `narrationConfigJson.playbackRate` 传入，totalSec 同步修正为 `coverSec + narrationDurationUs/1e6/playbackRate`；even 模式本来就是成片口径，不动。
- **存量修正**：`pointCuesKey` 计算加**版本盐**（如 `v2:` 前缀），所有旧组视为过期，下次配置/导出时按正确口径自动重提取一次（有卖点库零成本；无卖点库走 LLM/启发式，与现状同成本）。
- **单测**：`final-edit-packaging-cues.test.ts` 增加倍速 1.0/1.2 两组的换算断言 + 与字幕轨对齐误差断言。

## 10. 问题④ CMD 弹窗治理

1. **审计**：源码 `_src/creative-studio` + 部署根 `packaging/` + standalone 产物三处 grep 全部 `spawn|spawnSync|execFile|exec(`；核对 standalone 构建新旧（防止修复未同步）。
2. **复现定位**：本机跑真实「导出渲染+包装」，后台记录进程创建（PowerShell `Win32_ProcessStartTrace` 或轮询 `Get-CimInstance Win32_Process` 抓 `ParentProcessId`/`CommandLine`），拿到弹窗进程名与父链。
3. **收口**：新增统一 spawn 封装（强制 `windowsHide:true`，hyperframes CLI 一律 argv `--require win-hide-spawn.cjs`），全仓改走该入口；封装内设开发期断言（漏传 windowsHide 直接抛错）防回归。禁止 NODE_OPTIONS 注入（§10.3 已否决）、禁止 vendored 补丁（§9.3 已否决）。
4. **验证**：连续渲染多次零弹窗后，交用户真实导出复测。

## 11. 验收要点

- ①：播放头停在封面段时，改字体/文案/卖点后预览即时刷新且封面常挂；点播放从头完整播整片（封面→正片卖点弹出→结束），播完可回到封面。
- ②：封面段拖封面卖点、正片选中拖正片卖点，位置/缩放保存后刷新仍在；换模板互不影响；恢复默认版式生效；拖拽期间无 iframe 重载闪烁。
- ③：卖点轨增删改/移动/修剪全部生效且进成片；双击改字与右栏封面文案互不干扰；pointCuesEdited 保护生效（重录口播不覆盖手动卖点）；「重新提取」复位。
- ⑤（时间基准）：DB 三个真实组（ebff338f/bf3fe8a4/c412dd0e）重提取后，卖点块与对应字幕在轨上对齐误差 <0.2s；成片抽查 3 条卖点弹出与口播同步误差 <0.5s（倍速 1.0 与 1.2 各一遍）。
- 封面标题勾选：默认关（无旧标题），勾选后旧标题正常渲染/预览。
- ④：完整「导出渲染+包装」全程零 CMD/conhost 窗口。
- 回归：关闭包装导出 → 目录唯一正常成片（无叠加层/无卖点轨干扰）；四套模板各导出一次版式/吸色/字体正常；`final-edit-packaging-vars/cues/palette` 单测回归 + 新增 layouts 解析/合并单测。

## 12. 明确不做（YAGNI）

- 按画幅（9:16/16:9）分别记忆布局（坐标百分比自适应，后续需要再加）；
- 正片卖点数量硬上限、卖点与字幕联动跟随、撤销栈；
- 主/副标题在预览画面里的拖拽（本期仅卖点标签）；
- 旧封面标题数据清理（开关保留数据，向后兼容）；
- 批量生产模块的包装（包装功能仅单条混剪流程）。
