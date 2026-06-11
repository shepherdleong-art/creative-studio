# Code Review — 第二轮 5 项交互修复

> 审查日期：2026-06-12  
> 审查范围：`HEAD` 工作树变更（输出命名+分类、场景参考显示、分镜预览/重做、视频运镜）  
> 审查强度：max effort（8 角度 × 逐项验证）

---

## 🐛 确认 Bug（10 项，由重到轻）

### 1. loadShots 竞态条件 — ShotSetPanel
**文件**：`components/ShotSetPanel.tsx:109-117`

快速切换展开的分镜组时，前一个 `loadShots(A)` 的 async 响应可能在 `loadShots(B)` 之后到达，覆盖当前组 B 的 `shots` 和 `sceneRefInfo` 为 A 的数据。

**修复方向**：在 `setShots` / `setSceneRefInfo` 之前比较 `setId === expandedId`。

---

### 2. loadShotsForSet 竞态条件 — VideoGenerationPanel
**文件**：`components/VideoGenerationPanel.tsx:107-118`

快速切换分镜组下拉时，旧响应的 `setSelectedSetShots` / `setVideoJobs` 覆盖当前选中组的数据。

**修复方向**：加 `active` 标志或 AbortController。

---

### 3. PATCH 响应未检查 — handleRedo
**文件**：`components/ShotSetPanel.tsx:188-191`

```ts
await fetch(`/api/shot-sets/${expandedId}`, {
  method: 'PATCH', ...
});
await onShotChanged?.();  // 不检查 res.ok 直接继续
```

PATCH 失败时静默丢失，分镜未指向新 job，队列已启动但结果不会关联。

**修复方向**：加 `if (!res.ok) { alert(...); return; }`。

---

### 4. 键盘导航闭包过期
**文件**：`components/ShotSetPanel.tsx:155`

`useEffect` 中 `onKey` 读的是闭包中的 `previewIndex`。快速连按 `←←` 两次，两次 handler 看到同一个旧值，都算出一樣的 `next`，只移动一步。

**修复方向**：改用 `setPreviewIndex(prev => Math.max(0, Math.min(...)))`。

---

### 5. `key={idx}` 用数组下标 — motionRows
**文件**：`components/VideoGenerationPanel.tsx:251`

删除一行运动镜后，后续行 index 全变，React 复用错误 DOM 节点，导致表单状态串位（如 provider 下拉显示上一行的值）。

**修复方向**：用 `crypto.randomUUID()` 或 `uuid` 给每行生成稳定 key。

---

### 6. 重复 DB 查询 — queue.ts
**文件**：`lib/queue.ts:508`

第 200 行已 `SELECT * FROM image_assets` 拿到了 `usage`，但 TypeScript 类型断言漏了该字段，第 508 行又重新 `SELECT usage FROM image_assets` 查同一条记录。每个 job 完成多一次同步 DB 往返。

**修复方向**：在类型断言中加 `usage?: string`，直接用 `inputImage.usage`。

---

### 7. 孤儿 job 不可见
**文件**：`app/projects/[id]/page.tsx:152-165`

`sceneJobs` / `shotJobs` 按输入图片的 `usage` 过滤。如果输入图片没有 usage 标签（旧数据、异常上传），这些 job 在两个 tab 都看不到，只出现在 QueueCompactBar 计数中。

**修复方向**：在过滤逻辑中加一个「未分类」fallback 桶，或给旧图片打默认标签。

---

### 8. getJobStatus fallback 受限
**文件**：`components/ShotSetPanel.tsx:193`

StoryboardWorkspace 传给 ShotSetPanel 的 `jobs` 已经是过滤后的 `shotJobs`。如果 `shot.jobStatus` 异常缺失，fallback 用 `getJobStatus` 在过滤数组里查找，找不到非 `shot_source` 来源的 job，显示错误。

**修复方向**：优先信任 `shot.jobStatus`（来自 API），只在确实缺失时才 fallback，或把全量 jobs 也传入。

---

### 9. latestJobId 接受空字符串
**文件**：`app/api/shot-sets/[id]/route.ts:87`

```ts
typeof body.latestJobId === 'string'  // '' 也满足
```

没有长度校验，异常调用可写入空 `latestJobId`。

**修复方向**：加 `&& body.latestJobId.length > 0`。

---

### 10. LogViewer 卸载后 setState
**文件**：`components/LogViewer.tsx:57-63`

`loadLogs` 的 `finally { setLoading(false) }` 没有 `active` 标志。关闭日志抽屉时如果请求尚未完成，React 报 setState on unmounted warning（虽不崩溃但污染控制台）。

**修复方向**：加 `let active = true` 并在 cleanup 中置 `false`。

---

## 🔧 代码质量问题（5 项）

### 11. 前缀映射逻辑重复
`lib/queue.ts:508` 和 `app/api/jobs/[id]/resume-poll/route.ts:74` 中的 `scene_seed → 场景-` 映射完全一样。应抽到 `lib/output-filenames.ts`。

### 12. 输出保存流水线重复
`lib/queue.ts:501-527` 和 `resume-poll/route.ts:71-88` 的整个输出保存流程（建目录→命名→写文件→INSERT→UPDATE）是复制粘贴。改一处必落另一处。

### 13. O(m×n) 过滤效率
`page.tsx:152-165` 的 `sceneJobs`/`shotJobs` 每个 job 都 `images.find()` 遍历全量图片。应先建 `Map<imageId, usage>` 一次。

### 14. 预览弹窗重复实现
`ShotSetPanel.tsx:352-407` 的 ~70 行 inline IIFE 复刻了 `ResultGallery` 的弹窗结构。应抽成共享组件。

### 15. Batch 接口验证不一致
`video-jobs/batch/route.ts` 对 duration 越界静默钳制、空提示词静默丢弃，和单条接口的 400 报错行为不一致。

---

## 验证状态

| 检查 | 结果 |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ 0 errors |
| ESLint (`npm run lint`) | ✅ 0 errors, 40 warnings（均为项目 `<img>` 标签惯例） |
| Build (`npm run build`) | ✅ 通过 |

---

*审查工具：Claude Code (code-review skill, max effort)*
