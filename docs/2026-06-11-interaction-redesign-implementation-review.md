# 2026-06-11 交互重构第二轮验收

审查对象：`I:\batch-image-workbench-github`

实施记录：`docs/2026-06-11-interaction-redesign-review-fixes-implementation.md`

结论：相比上一轮已经补齐了大方向，但仍不建议合并为完成态。四步工作台结构基本出现了，供应商页、新建项目页、脚本 brief、顶层视频入口都有进展；当前剩余问题主要集中在真实使用时的上传归属、图片池混用、视频缩略图，以及少量数据校验。

## 已验证命令

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

结果：

- TypeScript：通过。
- Lint：通过，0 errors / 40 warnings。
- Build：通过。沙箱内第一次因 `.next/trace-build` 写入权限失败，提权后通过。
- Diff check：通过。

## 需要退回修的问题

### P1：多个 input 上传器复用同一个 DOM id，会导致上传入口串台

证据：

- `components/ImageUploader.tsx:137` 使用固定 `id={`upload-${role}`}`。
- `components/ImageUploader.tsx:140` 的 label 也固定指向 `upload-${role}`。
- 项目详情页同时出现至少两个 `role="input"` 上传器：
  - `app/projects/[id]/page.tsx:662`，新场景图上传。
  - `components/ShotSetPanel.tsx:125`，原始分镜图上传。

影响：

同一页面存在多个 `id="upload-input"`。用户点击第二个上传区域时，浏览器可能打开第一个 file input，导致上传回调和刷新逻辑串到场景图区域。现在场景上传的 `onUploaded` 还会触发 `ensureQueueRunning`，所以用户只是上传分镜图，也可能无意启动项目队列。

修复要求：

- 给 `ImageUploader` 增加稳定唯一 id。
- 推荐在组件内使用 React `useId()`，生成 `const inputId = useId()`，不要再只用 role 拼 id。
- 或增加可选 `inputId` prop，由调用方传 `scene-seed-upload`、`shot-source-upload`。
- 确认所有 label 都指向自己的 input。

验收：

- 项目详情页同时存在场景上传和分镜上传时，点击任一上传区域，只触发该区域自己的 `onUploaded`。

### P1：原始场景图 A 和原始分镜图仍混在同一个 `input` 图片池里

证据：

- `app/projects/[id]/page.tsx:424` 给 `SceneGenerationForm` 传入 `project.images.filter((img) => img.role === 'input')`。
- `components/ShotSetPanel.tsx:141` 创建分镜组时也列出 `images.filter((img) => img.role === 'input')`。
- `app/api/upload/route.ts:58` 目前只接受 `input/reference`，没有更细的用途字段。

影响：

用户上传的原始场景图 A 会出现在“创建分镜组”的候选图里；用户上传的原始分镜图也会出现在“原始场景图 A”的选择器里。空项目流程虽然有入口了，但素材归属仍然混乱，用户很容易把场景图当分镜，或把分镜当场景 seed。

修复要求：

- 不要新增非法 role，例如 `scene_seed`，因为数据库约束只有 `reference/input/output`。
- 建议在 `image_assets` 增加一个轻量字段，例如：

```sql
ALTER TABLE image_assets ADD COLUMN usage TEXT DEFAULT ''
```

可用值先约定：

- `scene_seed`
- `shot_source`
- 空字符串兼容旧数据

- `ImageUploader` 增加可选 `usage` prop，并随 `/api/upload` formData 写入。
- 场景上传传 `usage="scene_seed"`。
- 分镜上传传 `usage="shot_source"`。
- `SceneGenerationForm` 只列出 `usage='scene_seed'`，旧数据可在“更多/未分类素材”里兼容显示。
- `ShotSetPanel` 创建分镜组只列出 `usage='shot_source'`，不要把场景 seed 混进来。

验收：

- 上传场景图 A 后，它不出现在分镜组候选图列表。
- 上传分镜图后，它不出现在场景图 A 选择器。
- 旧项目已有 `usage=''` 的 input 图不会直接消失，至少有兼容入口或迁移策略。

### P2：`scene-jobs` API 没有校验图片归属，可能创建无效 job 或挪走其他项目素材

证据：

- `app/api/projects/[id]/scene-jobs/route.ts:34` 直接执行 `UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`。
- 该接口没有先查询 image 是否存在，也没有限制 image 当前属于本项目或未绑定项目。
- `app/api/projects/[id]/scene-jobs/route.ts:40-47` 随后直接创建 jobs。

影响：

如果传入不存在的 `sceneSeedImageId`，可能创建指向无效图片的 job；如果传入其他项目的 image id，可能把别的项目素材改绑到当前项目。即使 UI 正常，这也是 API 层的数据完整性漏洞。

修复要求：

- 创建 job 前先查：

```sql
SELECT id, projectId FROM image_assets WHERE id = ?
```

- 不存在则 400。
- `projectId` 既不是当前项目也不是 null 时返回 400。
- 如果引入 `usage`，还要校验或设置 `usage='scene_seed'`。
- 检查 UPDATE 的 `changes`，不是 1 时返回错误。

验收：

- 传入不存在的 image id 返回 400，不创建 job。
- 传入其他项目已绑定的 image id 返回 400，不改绑。

### P2：第 4 步视频缩略图 URL 拼错

证据：

- `components/VideoGenerationPanel.tsx:111` 把 `s.sourceImageId` 拼成 `imageUrl: `/api/images/${s.sourceImageId}``。
- `app/api/images/[...path]` 需要的是 storage 相对路径，不是 image asset id。
- `app/api/shot-sets/[id]/route.ts:18` 目前只返回 `sourcePath`，没有返回可直接用于前端的 `sourceImageUrl`。

影响：

第 4 步选择分镜组后，视频生成卡片里的分镜缩略图会请求错误地址，图片显示不出来。视频任务创建本身可能仍能走，但用户无法确认是哪张图。

修复要求：

- 在 `app/api/shot-sets/[id]/route.ts` 里像项目详情 API 一样把 `sourcePath` 转成 `/api/images/{relativePath}`。
- 同时为 `latestGeneratedImageId` 对应结果图也返回可显示 URL，优先展示生成后的分镜图；没有结果图时再展示原图。
- `VideoGenerationPanel` 使用 API 返回的 URL，不要手拼 asset id。

验收：

- 第 4 步选择分镜组后，每个分镜卡片都能显示正确缩略图。

### P2：单纯上传场景图也会启动队列

证据：

- `app/projects/[id]/page.tsx:424` 传给 `SceneGenerationForm` 的 `onCreated` 会 `loadProject()` 后 `ensureQueueRunning()`。
- `app/projects/[id]/page.tsx:662-664` 场景图上传完成后也调用同一个 `onCreated`。

影响：

用户只是上传原始场景图 A，还没点击“生成新场景图”，项目队列就可能被启动。空队列启动通常不会造成严重后果，但状态会让用户困惑，也可能触发无意义请求。

修复要求：

- 拆分回调：
  - `onUploaded`：只刷新项目数据。
  - `onJobsCreated`：刷新项目并启动队列。
- 上传素材不要启动队列；创建 pending jobs 后再启动队列。

验收：

- 上传场景图后不启动队列。
- 点击“生成新场景图”创建 jobs 后才启动队列。

### P3：新代码还有可清理 warning 和错误处理缺口

证据：

- `app/api/projects/[id]/scene-jobs/route.ts:28` 的 `concurrency` 未使用。
- `app/api/projects/[id]/script/route.ts:3` 的 `ScriptOutput` 未使用。
- `components/ShotSetPanel.tsx:117` 的 `getFilename` 未使用。
- `components/VideoGenerationPanel.tsx:3` 的 `useCallback` 未使用。
- `components/VideoGenerationPanel.tsx:192` 的 `getShotImageUrl` 未使用。
- `components/ScriptPanel.tsx:84-93` 的 `saveBrief` 没有检查 PATCH 是否失败，失败后仍会继续生成脚本。

修复要求：

- 清理本轮新增的 unused warnings。
- `saveBrief` 检查 `res.ok`，失败时抛错/提示并中止生成。
- 生成按钮在 brief 未加载时可以显示加载态，而不是静默 return。

## 已通过的点

- 供应商页已经移除“设为唯一启用”的前端入口。
- 新建复杂项目页已经变成项目壳创建。
- 新增了 `POST /api/projects/[id]/scene-jobs`，方向正确。
- “分镜生成”已移除嵌套视频组件，视频生成集中到第 4 步，方向正确。
- 脚本 brief 已从 `shot_sets.category` 迁到项目字段，方向正确。
- 顶层视频入口已经能加载分镜组列表，方向正确。

## 建议 Claude Code 下一步

优先修 P1/P2，不要再扩散新功能：

1. 修 `ImageUploader` 唯一 id。
2. 给上传素材补 `usage` 或等价的用途区分，并改两个图片选择器过滤逻辑。
3. 补 `scene-jobs` 图片归属校验。
4. 修第 4 步缩略图 URL。
5. 拆分上传刷新和创建 jobs 后启动队列的回调。
6. 清理新增 warning 和 `saveBrief` 错误处理。

修完后重新跑：

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```
