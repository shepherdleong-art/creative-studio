# 2026-06-11 交互重构 Round 3 验收

审查对象：`I:\batch-image-workbench-github`

实施记录：`docs/2026-06-11-interaction-redesign-round3-fixes.md`

结论：确实已经到临门一脚。本轮大部分退回项已修好，但复杂产品四步工作台里漏传了一个 prop，导致 P1 主流程仍会卡在“上传分镜后不能立即创建分镜组”。

## 已验证命令

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```

结果：

- TypeScript：通过。
- Lint：通过，0 errors / 34 warnings。
- Build：通过。沙箱内第一次因 `.next/trace` 写入权限失败，提权后通过。
- Diff check：通过。

## 仍需修复

### P1：复杂产品工作台的 `ShotSetPanel` 漏传 `onImagesUploaded`

证据：

- `components/ShotSetPanel.tsx:36` 已新增 `onImagesUploaded?: () => void`。
- `components/ShotSetPanel.tsx:126` 上传完成后会调用 `await onImagesUploaded?.(); await loadSets();`。
- `app/projects/[id]/page.tsx:570` 的 legacy 分支已经正确传了 `onImagesUploaded={loadProject}`。
- 但 `app/projects/[id]/page.tsx:453-458` 的复杂产品四步工作台分支没有传 `onImagesUploaded`。

影响：

新建复杂产品空项目后，用户在“2. 分镜生成”上传原始分镜图，上传完成后父级 `project.images` 不刷新，刚上传的图片仍不会立刻出现在“创建分镜组”的候选图里。用户需要刷新页面才行。

修复要求：

在复杂产品分支的 `ShotSetPanel` 调用处补上：

```tsx
<ShotSetPanel
  projectId={project.id}
  images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role, usage: img.usage }))}
  jobs={project.jobs}
  onApplyScene={openApplySceneModal}
  onImagesUploaded={loadProject}
/>
```

验收：

- 新建复杂产品空项目。
- 进入项目详情第 2 步。
- 上传原始分镜图。
- 不刷新页面，点击“创建分镜组”，刚上传的图应立即出现在候选列表。

## 已通过的 Round 3 项

- 场景图选择器已严格过滤 `usage === 'scene_seed'`。
- 分镜图选择器已严格过滤 `usage === 'shot_source'`。
- `/api/upload` 返回值和 `UploadedFile` 类型已补 `usage`。
- `idx` warning 已清理。
- 视频按钮文案已改为动态时长。

## 建议

这次只需要补上一个 prop，然后重新跑：

```powershell
npx tsc --noEmit --incremental false
npm run lint
npm run build
git diff --check
```
