# 2026-06-11 交互重构 Round 2 验收

审查对象：`I:\batch-image-workbench-github`

实施记录：`docs/2026-06-11-interaction-redesign-round2-fixes.md`

结论：本轮修复方向正确，主体已经接近可验收；但还有一个会阻断空项目“分镜生成”的问题，需要退回修掉。其他问题属于旧数据兼容和小清理。

## 已验证命令

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

结果：

- TypeScript：通过。
- Lint：通过，0 errors / 35 warnings。
- Build：通过。沙箱内第一次因 `.next/trace` 写入权限失败，提权后通过。
- Diff check：通过。

## 已通过的点

- `ImageUploader` 已改用 `useId()`，同页多个 input 上传器不再复用 `upload-input`。
- `/api/upload` 已支持 `usage`，并校验 `scene_seed` / `shot_source`。
- `image_assets` 已新增 `usage` migration。
- 场景上传传 `usage="scene_seed"`，分镜上传传 `usage="shot_source"`。
- `scene-jobs` API 已校验图片存在和项目归属。
- 场景上传和创建 job 的回调已拆开，单纯上传不会启动队列。
- 第 4 步视频缩略图改为使用 `sourceImageUrl` / `generatedImageUrl`。
- 脚本 brief 保存失败时会中止生成。

## 必修问题

### P1：分镜上传后不刷新父级项目图片，空项目无法立即创建分镜组

证据：

- `components/ShotSetPanel.tsx:124-126` 的分镜上传完成后只调用 `loadSets()`。
- `components/ShotSetPanel.tsx:140` 创建分镜组的候选图来自父组件传入的 `images` prop。
- `app/projects/[id]/page.tsx:453-458` 父组件传入 `project.images`，但 `ShotSetPanel` 上传后没有通知父组件重新 `loadProject()`。

影响：

新建空项目后，用户在“2. 分镜生成”上传原始分镜图，上传成功后候选图列表不会出现刚上传的图片。用户需要刷新页面或触发父级项目重新加载，才能创建分镜组。这会直接打断主流程。

修复要求：

- 给 `ShotSetPanel` 增加回调，例如 `onImagesUploaded?: () => void`。
- `ProjectDetailPage` 传入 `onImagesUploaded={loadProject}`。
- `ShotSetPanel` 上传完成后调用：

```ts
onUploaded={async () => {
  await onImagesUploaded?.();
  await loadSets();
}}
```

- 或者在 `ShotSetPanel` 内维护本地图片 state，把 `/api/upload` 返回的 files 立即并入候选图；但如果这样做，上传返回值必须包含 `usage`。

验收：

- 新建空项目后，在“分镜生成”上传原始分镜图，不刷新页面，点击“创建分镜组”即可看到刚上传的图片。

## 应修问题

### P2：`usage=''` 的旧 input 图片默认混入两个主选择器

证据：

- `app/projects/[id]/page.tsx:426` 场景图选择器过滤条件是 `!img.usage || img.usage === 'scene_seed'`。
- `components/ShotSetPanel.tsx:140` 分镜图候选过滤条件是 `!img.usage || img.usage === 'shot_source'`。

影响：

新上传的素材已经能分开；但旧项目里 `usage=''` 的 input 图片会同时出现在“原始场景图 A”和“原始分镜图”两个主列表里。我们前面确认的口径是：旧数据需要兼容入口，但默认不要混入两个主选择器。

修复要求：

- 主列表默认只展示明确用途：

```ts
img.role === 'input' && img.usage === 'scene_seed'
img.role === 'input' && img.usage === 'shot_source'
```

- 给两个面板各加一个小的兼容入口，例如“显示未分类素材”开关。
- 未分类素材条件：`img.role === 'input' && !img.usage`。
- 选择未分类素材用于场景图生成时，提交 `scene-jobs` 后会被设置为 `scene_seed`。
- 选择未分类素材创建分镜组时，建议在创建成功后把这些 image_assets 更新为 `usage='shot_source'`。

验收：

- 新项目正常上传后，场景图和分镜图互不串。
- 旧项目未分类图片不默认混进两个主列表，但用户能显式打开兼容入口处理旧素材。

### P2：上传返回数据和 `UploadedFile` 类型没有带 `usage`

证据：

- `components/ImageUploader.tsx:5-19` 的 `UploadedFile` 没有 `usage`。
- `app/api/upload/route.ts:167-181` 返回的 file 对象没有 `usage`。

影响：

当前场景上传靠父级 `loadProject()` 刷新，所以暂时没暴露；但如果按上面 P1 选择“本地并入候选图”的方案，缺少 `usage` 会继续造成前端无法正确过滤。即使走父级刷新，也建议保持 API 返回与数据库字段一致。

修复要求：

- `UploadedFile` 增加 `usage?: string`。
- `/api/upload` 返回结果里带上 `usage`。

## 清理建议

### P3：本轮还剩一个新增/可清理 warning

证据：

- `components/ShotSetPanel.tsx:140` 的 `idx` 未使用。

修复要求：

- 删除 `.map((img, idx) => ... )` 里的 `idx`，改为 `.map((img) => ... )`。

### P3：视频生成按钮文案固定写“5 秒”

证据：

- `components/VideoGenerationPanel.tsx:262` 按钮文案固定为 `生成 5 秒视频`。
- 旁边 duration input 允许用户改 2-15 秒。

影响：

用户改成 10 秒时，按钮仍写 5 秒，容易误解。

修复要求：

- 文案跟随当前 shot 的 duration，或改成不含秒数的 `生成视频`。

## 建议 Claude Code 下一步

先修 P1；P1 修完后，空项目主流程才真正顺。然后处理 P2 的旧数据兼容口径和上传返回 `usage`，最后清掉 P3 小问题。

修完后重新跑：

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```
