# 交互重构第二轮修复实施记录 — 2026-06-11

> Claude Code 实施 · 仓库：`I:\batch-image-workbench-github`  
> 分支：`save/2026-06-10-video-script-workbench-v1`  
> 对照文档：`docs/2026-06-11-interaction-redesign-implementation-review.md`

## 验收状态

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 35 warnings（比上轮 40 减少 5） |
| `npm run build` | ✅ 通过 |
| `git diff --check` | ✅ 通过 |

---

## P1: ImageUploader 共用 DOM id 导致串台

### 问题

多个 `role="input"` 的 ImageUploader 使用相同 `id="upload-input"`。点击第二个上传区域，浏览器可能打开第一个 file input，导致回调解耦到错误组件。

### 修复

**文件：** `components/ImageUploader.tsx`

- 导入 `useId`：`import { useCallback, useState, useId } from 'react'`
- 组件内 `const inputId = useId()` 生成唯一 id
- `<input id={inputId}>` 和 `<label htmlFor={inputId}>` 替代硬编码 `upload-${role}`

---

## P1: 场景图 A 和原始分镜图混在同一个 input 图片池

### 问题

两个选择器都用 `img.role === 'input'` 过滤，导致上传的场景图出现在分镜候选里，反之亦然。

### 修复：新增 `usage` 字段

**文件：** `lib/db.ts`
```sql
ALTER TABLE image_assets ADD COLUMN usage TEXT DEFAULT ''
```

**文件：** `components/ImageUploader.tsx`
- Props 新增 `usage?: string`
- 上传时 `if (usage) form.append('usage', usage)`

**文件：** `app/api/upload/route.ts`
- 读取 `const usage = (formData.get('usage') as string) || ''`
- 白名单校验：`['', 'scene_seed', 'shot_source']`
- INSERT 语句加入 `usage` 列和值

**文件：** `app/projects/[id]/page.tsx`（SceneGenerationForm）
- ImageUploader 传入 `usage="scene_seed"`
- 图片选择器过滤：`img.role === 'input' && (!img.usage || img.usage === 'scene_seed')`
- 旧数据 `usage=''` 兼容显示（默认纳入场景选择器）

**文件：** `components/ShotSetPanel.tsx`
- ImageUploader 传入 `usage="shot_source"`
- 图片选择器过滤：`img.role === 'input' && (!img.usage || img.usage === 'shot_source')`
- Images prop 类型新增 `usage?: string`

---

## P1: 上传素材触发队列启动

### 问题

SceneGenerationForm 的 `onCreated` 在上传和 job 创建时共用，导致单纯上传场景图也调用 `ensureQueueRunning()`。

### 修复

**文件：** `app/projects/[id]/page.tsx`（SceneGenerationForm）
- Props 拆分为 `onUploaded`（只刷新项目）和 `onJobsCreated`（刷新 + 启动队列）
- 上传区回调：`onUploaded={loadProject}`
- 创建 job 成功后回调：`onJobsCreated={async () => { await loadProject(); await ensureQueueRunning(); }}`

---

## P2: scene-jobs API 无图片归属校验

### 问题

直接 `UPDATE image_assets SET projectId = ?` 而不检查图片是否存在或是否属于其他项目。传入不存在的 id 创建无效 job，传入其他项目 id 改绑素材。

### 修复

**文件：** `app/api/projects/[id]/scene-jobs/route.ts`
```ts
// 事务前先校验
const img = db.prepare(`SELECT id, projectId FROM image_assets WHERE id = ?`).get(sceneSeedImageId);
if (!img) return 400 '场景图 A 不存在';
if (img.projectId && img.projectId !== id) return 400 '图片不属于当前项目';

// 绑定同时设置 usage
db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input', usage = 'scene_seed' WHERE id = ?`).run(id, sceneSeedImageId);
```

---

## P2: 第 4 步视频缩略图 URL 拼错

### 问题

VideoGenerationPanel 用 `imageUrl: /api/images/${s.sourceImageId}`（asset id）拼接 URL，但 `/api/images/[...path]` 需要 storage 相对路径，导致图片不显示。

### 修复

**文件：** `app/api/shot-sets/[id]/route.ts`
- 导入 `path` 模块
- 查询 `sourcePath` 和 `latestGeneratedImageId` 对应文件的 path
- 计算 `sourceImageUrl` 和 `generatedImageUrl`（`/api/images/{relativePath}`）
- 返回 shots 时附带这两个 URL

**文件：** `components/VideoGenerationPanel.tsx`
- shots 映射时使用 API 返回的 URL：`s.generatedImageUrl || s.sourceImageUrl || ''`

---

## P3: 清理

| 文件 | 清理内容 |
|------|----------|
| `app/api/projects/[id]/scene-jobs/route.ts` | 删除未用的 `concurrency` 变量 |
| `components/ShotSetPanel.tsx` | 删除未用的 `getFilename` |
| `components/VideoGenerationPanel.tsx` | 删除未用的 `getShotImageUrl`、`useCallback`、`useRef` import |
| `app/api/projects/[id]/script/route.ts` | 删除未用的 `ScriptOutput` import |
| `components/ScriptPanel.tsx` | `saveBrief` 检查 `res.ok`，失败抛错；`handleGenerate` 捕获错误并提示用户 |

---

## 修改文件清单

| 文件 | 改动类型 |
|------|----------|
| `lib/db.ts` | 新增 migration：`image_assets.usage` |
| `components/ImageUploader.tsx` | `useId()` + `usage` prop |
| `app/api/upload/route.ts` | 读取/校验/保存 `usage` |
| `app/projects/[id]/page.tsx` | SceneGenerationForm 拆回调 + usage 过滤 + ImageAsset 加 usage |
| `components/ShotSetPanel.tsx` | usage 传值 + 过滤 + 删 getFilename |
| `app/api/projects/[id]/scene-jobs/route.ts` | 图片归属校验 + 删 concurrency |
| `app/api/shot-sets/[id]/route.ts` | 返回 sourceImageUrl + generatedImageUrl |
| `components/VideoGenerationPanel.tsx` | 用 API URL + 删 getShotImageUrl/useCallback |
| `components/ScriptPanel.tsx` | saveBrief 错误处理 |
| `app/api/projects/[id]/script/route.ts` | 删 ScriptOutput |
