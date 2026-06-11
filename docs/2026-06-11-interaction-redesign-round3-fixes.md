# 交互重构 Round 3 修复实施记录 — 2026-06-11

> Claude Code 实施 · 仓库：`I:\batch-image-workbench-github`  
> 分支：`save/2026-06-10-video-script-workbench-v1`  
> 对照文档：`docs/2026-06-11-interaction-redesign-round2-review.md`

## 验收状态

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 34 warnings（比上轮 35 减少 1） |
| `npm run build` | ✅ 通过 |
| `git diff --check` | ✅ 通过 |

---

## P1: 分镜上传后不刷新父级图片列表

### 问题

ShotSetPanel 上传完成后只调用 `loadSets()`（刷新分镜组列表），不通知父组件 `loadProject()`，导致刚上传的图片不出现在候选图列表中。用户需刷新页面或手动触发才能创建分镜组。

### 修复

**文件：** `components/ShotSetPanel.tsx`
- Props 新增 `onImagesUploaded?: () => void`
- 上传回调改为：`onUploaded={async () => { await onImagesUploaded?.(); await loadSets(); }}`

**文件：** `app/projects/[id]/page.tsx`
- ShotSetPanel 传入 `onImagesUploaded={loadProject}`

---

## P2: 旧数据 usage='' 默认混入选择器

### 问题

旧项目图片 `usage=''` 被 `!img.usage \|\| img.usage === 'xxx'` 同时匹配两个条件，混入场景图和分镜图两个选择器。

### 修复：严格过滤

**文件：** `app/projects/[id]/page.tsx`（SceneGenerationForm）
```ts
// 之前
img.role === 'input' && (!img.usage || img.usage === 'scene_seed')
// 之后
img.role === 'input' && img.usage === 'scene_seed'
```

**文件：** `components/ShotSetPanel.tsx`
```ts
// 之前
img.role === 'input' && (!img.usage || img.usage === 'shot_source')
// 之后
img.role === 'input' && img.usage === 'shot_source'
```

旧数据 `usage=''` 不再默认出现；未来可加"显示未分类素材"开关作为兼容入口。

---

## P2: UploadedFile 类型和 API 返回缺少 usage

### 修复

**文件：** `components/ImageUploader.tsx`
- `UploadedFile` 接口新增 `usage?: string`

**文件：** `app/api/upload/route.ts`
- `results` 数组类型新增 `usage?: string`
- 返回对象新增 `usage: usage || undefined`

---

## P3: 小清理

| 文件 | 清理内容 |
|------|----------|
| `components/ShotSetPanel.tsx:140` | `.map((img, idx) => ...)` → `.map((img) => ...)` 删除未用 `idx` |
| `components/VideoGenerationPanel.tsx:262` | `生成 5 秒视频` → ``生成 ${duration} 秒视频`` 动态时长 |

---

## 修改文件清单

| 文件 | 改动类型 |
|------|----------|
| `components/ShotSetPanel.tsx` | +onImagesUploaded prop + 严格过滤 + 删 idx |
| `app/projects/[id]/page.tsx` | ShotSetPanel 传 onImagesUploaded + 严格过滤 |
| `components/ImageUploader.tsx` | UploadedFile 加 usage |
| `app/api/upload/route.ts` | results 类型 + 返回值加 usage |
| `components/VideoGenerationPanel.tsx` | 动态时长文案 |
