# 交互重构验收修复实施记录 — 2026-06-11

> Claude Code 实施 · 仓库：`I:\batch-image-workbench-github`  
> 分支：`save/2026-06-10-video-script-workbench-v1`  
> 对照文档：`docs/2026-06-11-interaction-redesign-review-fixes.md`

## 验收状态

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 40 warnings（比修前 43 减少 3） |
| `git diff --check` | ✅ 通过 |

---

## P1.1: 空项目无法执行"新场景图生成"

### 新增 API

**文件：** `app/api/projects/[id]/scene-jobs/route.ts`（新建）

```
POST /api/projects/[id]/scene-jobs

body: { sceneSeedImageId, scenePrompt, generationCount }

后端：
- 校验项目存在且 workflowType=complex_product
- 绑定图片到项目 (UPDATE image_assets SET projectId=?)
- 更新项目 scenePrompt
- 创建 N 条 scene generation jobs（inputImageId=场景图, refs=[]）
- 返回 jobCount + jobIds
```

### Panel 1 新增组件

**文件：** `app/projects/[id]/page.tsx`

新增模块级组件 `SceneGenerationForm`：
- 上传按钮：使用 `ImageUploader`（role=input, maxFiles=1, projectId 绑定）
- 「+ 生成新场景图」按钮：展开内嵌表单
- 表单内容：图片选择器（下拉选已上传的 input 图片）+ 数量 + 提示词 textarea
- 提交调用 `/api/projects/[id]/scene-jobs`，成功后刷新项目 + 启动队列

新增 import：`ImageUploader` from `@/components/ImageUploader`

---

## P1.2: 空项目无法执行"分镜生成"的原始分镜上传

### ShotSetPanel 新增上传入口

**文件：** `components/ShotSetPanel.tsx`

- 标题区新增 `ImageUploader`（role=input, maxFiles=9, projectId 绑定）
- 上传完成后调用 `loadSets()` 刷新列表
- 移除嵌套的 `VideoGenerationPanel`（视频统一到 Panel 4）
- 按钮文案：「批量应用场景」→「生成分镜」

新增 import：`ImageUploader` from `@/components/ImageUploader`（替换 `VideoGenerationPanel`）

---

## P1.3: 脚本生成没有接收卖点/人群/语气/平台

### DB 迁移

**文件：** `lib/db.ts`

4 条新 migration：
```sql
ALTER TABLE projects ADD COLUMN targetAudience TEXT DEFAULT ''
ALTER TABLE projects ADD COLUMN scriptTone TEXT DEFAULT '种草'
ALTER TABLE projects ADD COLUMN scriptPlatform TEXT DEFAULT '通用'
ALTER TABLE projects ADD COLUMN sellingPointsJson TEXT DEFAULT '[]'
```

### ScriptPanel 新增卖点表单

**文件：** `components/ScriptPanel.tsx`

- 新增 state：`audience`, `tone`, `platform`, `sellingPoints`, `briefLoaded`
- 新增 `loadBrief` effect：从 `/api/projects/[id]` GET 读取 brief 字段
- 新增 `saveBrief`：生成前调 PATCH API 保存 brief
- JSX 新增 brief 表单：人群输入框 + 语气下拉 + 平台下拉 + 卖点 textarea
- `handleGenerate` 先 `saveBrief()` 再调脚本 API

### API 更新

**文件：** `app/api/projects/[id]/script/route.ts`

- 卖点解析从 `shot_sets.category LIKE '%sellingPoints%'` 改为读 `project.sellingPointsJson`
- `targetAudience`/`tone`/`platform` 从 project 字段读取（不再写死）
- `inputSnapshot` 保存真实 brief 数据

**文件：** `app/api/projects/[id]/route.ts`（PATCH）

- 从只支持 `shotPrompt` 改为动态更新多字段
- 支持字段：`shotPrompt`, `targetAudience`, `scriptTone`, `scriptPlatform`, `sellingPointsJson`
- 不再强制要求 `shotPrompt` 非空（允许单独更新 brief 字段）

---

## P2: 视频生成改成顶层真实入口

### VideoGenerationPanel 重构

**文件：** `components/VideoGenerationPanel.tsx`

| 之前 | 之后 |
|------|------|
| 必须传入 `shotSetId` + `shots` | 两个 props 均改为可选 |
| 无 shotSetId 时显示静态提示 | 加载项目分镜组列表，显示选择器 |
| `loadData` callback 直接拼 URL | 拆分为：providers/templates 加载一次，视频 jobs 按需加载 |
| `safeShots` 重复声明 | 统一为一个声明 |
| `loadData` 调用处改为 `refreshJobs` | |

新增逻辑：
- `availableSets` state：加载 `/api/projects/[id]/shot-sets`
- 分镜组下拉选择器：选中后加载 shots + video jobs
- 无分镜组时显示提示
- `effectiveSetId` = `shotSetId || selectedSetId`

### ShotSetPanel 移出视频

**文件：** `components/ShotSetPanel.tsx`

- 删除嵌套的 `<VideoGenerationPanel>` 组件（原 lines 236-247）
- 删除 `import VideoGenerationPanel`

---

## P3: 清理

### 旧术语统一

| 位置 | 旧文案 | 新文案 |
|------|--------|--------|
| `page.tsx:259` | 分镜重做模板不能为空 | 分镜生成模板不能为空 |
| `page.tsx:598` | 批量应用场景到分镜组 | 选择新场景图并生成分镜 |
| `ShotSetPanel.tsx:193` | 批量应用场景 | 生成分镜 |

### 未使用代码清理

**文件：** `app/projects/new/page.tsx`

删除 4 个废弃常量（complex 表单已不再使用）：
- `DEFAULT_SCENE_PROMPT`
- `DEFAULT_SHOT_PROMPT`
- `TONE_OPTIONS`
- `PLATFORM_OPTIONS`

lint warning 从 43 降至 40。

---

## 修改文件清单

| 文件 | 改动类型 |
|------|----------|
| `app/api/projects/[id]/scene-jobs/route.ts` | 新建 |
| `app/projects/[id]/page.tsx` | 新增 SceneGenerationForm + import ImageUploader + 修复 JSX 结构 + 术语 |
| `components/ShotSetPanel.tsx` | 新增加载上传 + 删除 VideoGenerationPanel + 术语 |
| `components/ScriptPanel.tsx` | 新增 brief 表单 + loadBrief/saveBrief |
| `components/VideoGenerationPanel.tsx` | 重构：分镜组选择器 + refreshJobs + props 可选 |
| `lib/db.ts` | 4 条新 migration（brief 列） |
| `app/api/projects/[id]/route.ts` | PATCH 改为动态多字段更新 |
| `app/api/projects/[id]/script/route.ts` | 卖点/人群/语气/平台从 project 字段读取 |
| `app/projects/new/page.tsx` | 删除 4 个废弃常量 |
