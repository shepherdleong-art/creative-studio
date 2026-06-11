# 2026-06-11 交互重构验收退回单

审查对象：`I:\batch-image-workbench-github`

分支：`save/2026-06-10-video-script-workbench-v1`

相关实现文档：`docs/2026-06-11-interaction-redesign-implementation.md`

## 验收结论

当前实现还不能按“新建项目 -> 项目详情 1/2/3/4 独立工作台”的目标交付。供应商页移除“设为唯一启用”这一点基本通过，新建项目页也已经缩成项目壳创建；但是项目详情页的几个核心板块目前只是分区展示，缺少实际操作入口，空项目创建后会卡在流程里。

本轮先不直接改业务代码。下面是需要 Claude Code 继续执行的修复清单。

## 验证情况

已运行：

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

结果：

- TypeScript：通过。
- Lint：通过，但有 43 个 warning，比实现文档记录的“既有 40 个 warning”更多。
- Build：通过。第一次在沙箱内因 `.next/trace` 写入权限失败，提升权限后通过。
- Diff check：通过。

## 必修问题

### P1：空项目无法真正执行“1. 新场景图生成”

证据：

- `app/projects/new/page.tsx:296-345` 的复杂项目创建页只保留项目信息、供应商、模型参数和创建按钮，不再上传原始场景图 A。
- `app/projects/[id]/page.tsx:417-434` 的“新场景图生成”只渲染说明、已有提示词和 `ResultGallery`，没有上传原始场景图 A、编辑/确认提示词、创建生成任务、启动队列的入口。
- `app/api/projects/route.ts:117-133` 只有在创建项目时传入 `sceneSeedImageId + scenePrompt + shotImageIds` 才创建场景 job；新建项目壳不传这些字段，因此详情页也没有后续补建 job 的路径。

影响：

用户按新逻辑创建一个空项目后，第一步没有可执行动作，只能看到空 gallery。

要求：

- 在项目详情的“1. 新场景图生成”中补齐完整操作：
  - 上传/选择原始场景图 A。
  - 编辑场景提示词，默认使用项目 `scenePrompt`。
  - 配置生成数量、并发/重试等必要参数，或复用项目默认参数。
  - 创建场景图生成 jobs，并能启动/重试/查看结果。
  - 生成结果仍可设为后续使用的场景参考图。
- 添加或复用后端入口。可以新增 `POST /api/projects/[id]/scene-jobs`，也可以扩展现有项目 API，但必须支持“项目已创建后再上传素材并创建场景生成任务”。

验收：

- 新建一个复杂项目壳后，不回到新建页，也不手写数据库，能在详情页上传原始场景图 A 并生成新场景图。

### P1：空项目无法真正执行“2. 分镜生成”的原始分镜上传整理

证据：

- `app/projects/new/page.tsx:296-345` 已移除原始分镜图上传。
- `app/projects/[id]/page.tsx:443-452` 只把已有 `project.images` 传给 `ShotSetPanel`。
- `components/ShotSetPanel.tsx:1-30` 没有引入或使用 `ImageUploader`。
- `components/ShotSetPanel.tsx:186-188` 只有对已有分镜组执行“批量应用场景”的按钮，没有原始分镜上传入口。

影响：

空项目没有任何 `role='input'` 的原始分镜图。用户无法在“分镜生成”页面完成“上面上传整理、下面生成”的目标流程。

要求：

- 在“2. 分镜生成”板块内合并原始分镜图上传和分镜生成：
  - 上半部分：上传/追加/删除原始分镜图，能看到排序和文件状态。
  - 中间：基于已上传原始分镜创建或更新分镜组。
  - 下半部分：选择新场景参考图，批量生成分镜图。
- 注意不要让“原始场景图 A”和“原始分镜图”都混成同一个不可区分的 `input` 池。若沿用 `image_assets.role`，建议至少在 UI 侧明确过滤；更稳的是补充更明确的 role 或关联表。

验收：

- 新建空项目后，用户能直接在“分镜生成”板块上传原始分镜图，创建分镜组，并用已选场景参考图生成新分镜。

### P1：脚本生成没有真正接收“卖点/人群/语气/平台”

证据：

- `components/ScriptPanel.tsx:131-162` 只有生成按钮、草稿选择和说明文字，没有目标人群、语气、平台、卖点输入。
- `app/api/projects/[id]/script/route.ts:42-60` 仍从 `shot_sets.category LIKE '%sellingPoints%'` 解析卖点，并把 `targetAudience` 写死为空，把 `tone` 写死为 `种草`，把 `platform` 写死为 `通用`。
- 新建项目页已经移除卖点区，因此新流程里没有稳定 UI 路径写入这些信息。

影响：

用户要求“卖点那里也是 1234 一样独立清晰”，现在卖点既没有出现在脚本板块，也没有可靠数据结构。生成脚本时会忽略用户想配置的核心 brief。

要求：

- 把脚本 brief 放进“3. 脚本生成”板块：
  - 目标人群。
  - 语气。
  - 平台。
  - 卖点列表，支持增删改，每行一条或结构化标题/描述均可。
- 增加稳定存储，不要继续把卖点塞进 `shot_sets.category`。
  - 可选方案 A：在 `projects` 增加 `targetAudience`、`scriptTone`、`scriptPlatform`、`sellingPointsJson`。
  - 可选方案 B：新增 `project_script_briefs` 表。
- 更新脚本 API，生成时读取上述 brief，并把 `inputSnapshot` 保存为真实输入。

验收：

- 新建空项目后，用户能在“脚本生成”板块填写卖点、人群、语气、平台，然后生成脚本；生成结果的 `inputSnapshot` 能看到这些字段。

### P2：“4. 视频生成”还是占位，实际视频生成仍嵌在分镜组里

证据：

- `app/projects/[id]/page.tsx:529-533` 顶层“视频生成”只传了 `projectId` 给 `VideoGenerationPanel`。
- `components/VideoGenerationPanel.tsx:149` 如果没有 `shotSetId` 直接返回提示文字。
- `components/ShotSetPanel.tsx:231-238` 真实的视频生成组件仍嵌在每个展开的分镜组内部。
- `components/VideoGenerationPanel.tsx:77` 在 `shotSetId` 可能为空时仍拼接 `/api/shot-sets/${shotSetId}/video-jobs`，当前因为 loading 顺序不会立刻暴露成崩溃，但组件职责已经不清晰。

影响：

页面看起来有第 4 步，但用户仍需要回到第 2 步展开分镜组才能做视频，和“脚本生成后面，再之后就是视频生成”的交互目标不一致。

要求：

- 让“4. 视频生成”成为真实入口：
  - 顶层列出可用分镜组。
  - 选择分镜组后展示该组分镜和视频生成控制。
  - 能创建、刷新、下载视频任务。
- 二选一：
  - 把 `VideoGenerationPanel` 改造成可选分镜组的顶层面板，并从 `ShotSetPanel` 移除嵌套视频生成。
  - 或拆出 `VideoGenerationPanel` 的内部“某个分镜组的视频任务”子组件，顶层负责选择分镜组。
- `loadData` 在没有 `shotSetId` 时不要请求 `/api/shot-sets/undefined/video-jobs`。

验收：

- 用户完成或已有分镜组后，可以只在第 4 步完成视频生成，不需要回到第 2 步展开分镜组。

## 清理问题

### P3：旧术语没有清理干净

证据：

- `app/projects/[id]/page.tsx:258` 仍提示“分镜重做模板不能为空”。
- `app/projects/[id]/page.tsx:597` 仍写“批量应用场景到分镜组”。
- `components/ShotSetPanel.tsx:188` 仍写“批量应用场景”。

要求：

- 统一为“分镜生成模板”“生成分镜”“选择新场景图并生成分镜”等用户能理解的说法。
- 不要再出现“分镜重做”。

### P3：新建项目页引入了新的 lint warnings

证据：

- `app/projects/new/page.tsx:7-8` 的 `ImageUploader`、`UploadedFile` 在复杂项目页移除上传后，只有 legacy 分支还需要确认实际使用情况。
- 当前 lint warning 数从实现文档中的 40 增加到 43。重点清理 `DEFAULT_SCENE_PROMPT`、`DEFAULT_SHOT_PROMPT`、`TONE_OPTIONS`、`PLATFORM_OPTIONS` 等废弃常量。

要求：

- 删除未使用 import、常量和状态。
- 修复本轮新增 warning；历史 warning 可以不在本次全部解决，但 warning 数不应继续上涨。

## 回归验收清单

请 Claude Code 修完后至少手动跑一遍：

1. 打开供应商配置页，确认只有启用/禁用/编辑/删除，没有“设为唯一启用”。
2. 新建复杂项目，只填项目信息和供应商参数，创建后进入项目详情。
3. 在“1. 新场景图生成”上传原始场景图 A，生成候选图，并设为场景参考图。
4. 在“2. 分镜生成”上传原始分镜图，整理成分镜组，选择场景参考图并生成新分镜。
5. 在“3. 脚本生成”填写目标人群、语气、平台、卖点，生成脚本。
6. 在“4. 视频生成”选择分镜组，创建视频任务，能刷新状态并下载结果。
7. 单独进入任一板块时，缺少前置数据只显示本板块内部提示，不把整个板块置灰或锁死。

命令验证：

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

交付标准：

- 上面 1-7 条全部通过。
- TypeScript、lint、build、diff check 均通过。
- 本轮新增 warning 清零或明确说明无法清理的原因。
