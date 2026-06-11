# 交互重构实施记录 — 2026-06-11

> Claude Code 实施 · 仓库：`I:\batch-image-workbench-github`  
> 分支：`save/2026-06-10-video-script-workbench-v1`  
> 对照文档：`docs/2026-06-11-workbench-interaction-redesign-for-claude-code.md`

## 实施摘要

按文档建议的 8 步顺序执行，完成了 Steps 1-7。Step 8（统一中文术语清理）已在各步骤中同步完成。

---

## Step 1: 供应商页 — 删除「设为唯一启用」

**文件：** `app/settings/page.tsx`

- 删除 `handleActivateOnly` 函数（原 164-177 行）
- 删除「设为唯一启用」按钮（原 295-301 行）
- 页面说明文案改为「可以保存多个供应商，只有启用且已配置 Key 的供应商会出现在新建项目中。允许多个供应商同时启用。」

---

## Step 2: 新建项目页 — 瘦身为项目壳

**文件：** `app/projects/new/page.tsx`

### 移除的内容
- 场景图 A 上传区块
- 新场景图生成提示词 + 数量 + 并发设置
- 原始分镜图上传 + 排序预览
- 分镜重做模板 textarea
- 产品卖点区块（目标人群、语气、平台、卖点列表）
- `DEFAULT_SCENE_PROMPT`、`DEFAULT_SHOT_PROMPT`、`TONE_OPTIONS`、`PLATFORM_OPTIONS` 等常量
- `sceneAFiles`、`scenePrompt`、`shotFiles`、`shotPrompt`、`targetAudience`、`tone`、`platform`、`sellingPoints`、`sceneConcurrency` 等 state

### 保留的内容
- 项目名称、产品名称/编号/品类
- 工作流类型 toggle（复杂产品 / 旧版批量编辑）
- 供应商选择
- 模型参数（模型名、画面比例、清晰度、质量、超时）
- 图片预处理（折叠到 `<details>` 高级设置）
- 旧版批量编辑完整表单

### API 调用变化
- POST body 不再传 `sceneSeedImageId`、`scenePrompt`、`shotImageIds`、`shotPrompt`
- 创建后不再自动调用 `/api/projects/[id]/run`
- 按钮文案：「创建项目并生成场景图 B」→「创建项目」

---

## Step 3: 后端 — 放宽 complex_product 校验

**文件：** `app/api/projects/route.ts`

### 之前
强制要求 `sceneSeedImageId`、`scenePrompt`、`shotImageIds`，缺一返回 400。

### 之后
- 新增 `hasFullCreation` 判断：只有三个字段都存在时才执行完整创建（绑定图片、创建场景 job、创建 draft ShotSet）
- 不传素材时只建项目壳：写入默认 scenePrompt/shotPrompt 模板，不创建 job 和 ShotSet
- 旧版完整创建逻辑保留在 `hasFullCreation` 分支内，向后兼容

---

## Step 4-7: 项目详情页 — 4 板块工作台

**文件：** `app/projects/[id]/page.tsx`

### 之前结构（complex_product）
```
阶段 1：场景图 B 候选（ResultGallery）
阶段 2：场景参考图（SceneReferencePanel）
阶段 3：分镜重做模板 + ShotSetPanel
阶段 5：脚本生成（ScriptPanel）
任务队列
```

### 之后结构
```
1. 新场景图生成
   ├─ ResultGallery（场景候选结果）
   └─ SceneReferencePanel（已选场景参考图）

2. 分镜生成
   ├─ ShotSetPanel（创建/管理分镜组）
   └─ 分镜生成模板（可编辑）

3. 脚本生成
   └─ ScriptPanel

4. 视频生成
   └─ VideoGenerationPanel（无分镜组时显示提示）
```

### 术语替换
- 「场景图 B 候选」→「新场景图生成」
- 「分镜重做模板」→「分镜生成模板」
- 「阶段 1-5」→「1-4 板块编号」
- 每个板块加了 `id` 锚点（`panel-scene`/`panel-shot`/`panel-script`/`panel-video`）方便未来导航

### 导入新增
- `import VideoGenerationPanel from '@/components/VideoGenerationPanel'`

---

## Step 7 附带: VideoGenerationPanel 适配

**文件：** `components/VideoGenerationPanel.tsx`

- `Props.shotSetId` 和 `Props.shots` 改为可选
- 无 shotSetId 时显示轻提示，不崩溃
- 新增 `safeShots` 变量避免 `undefined.map()` 错误
- 不影响已有功能（原有调用方仍传完整 props）

---

## 验收状态

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 43 warnings（全部为已有） |
| 空项目壳创建 | ✅ 只填项目名+供应商即可创建，跳转详情页 |
| 4 板块可见 | ✅ 新项目详情页显示 4 个主板块 |
| 缺材料不崩溃 | ✅ 每个板块缺少材料时正常显示 |
| 供应商无「唯一启用」 | ✅ 按钮和相关逻辑已删除 |
| 旧版批量编辑 | ✅ toggle 切换到 legacy 模式，完整可用 |

---

## 未覆盖的 Step 8 项

文档建议的 Step 8（统一中文文案清理）已在实施中覆盖主要位置。以下可能需要后续检查：

- `components/ShotSetPanel.tsx` — 「批量应用场景」按钮文案未改，需考虑是否改为「开始分镜生成」
- `components/SceneReferencePanel.tsx` — 组件内部可能还有旧术语
- `app/api/*` 路由中的注释和错误消息

---

## 修改文件清单

| 文件 | 改动类型 |
|------|----------|
| `app/settings/page.tsx` | 删除「唯一启用」UI + 逻辑 |
| `app/projects/new/page.tsx` | 复杂产品表单瘦身 |
| `app/api/projects/route.ts` | 放宽校验，支持空壳 |
| `app/projects/[id]/page.tsx` | 详情页重排为 4 板块 |
| `components/VideoGenerationPanel.tsx` | props 可选，空状态处理 |
