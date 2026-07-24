# 智能混剪 V1 — 完成评审与偏差处置记录

> 日期：2026-07-24（晚）
> 状态：执行完成，已评审、已按评审结论修复、已合并回 `mixcut01`
> 依据：PRD `../specs/2026-07-23-mixcut-prd.md`、技术计划 `2026-07-23-mixcut-technical-execution.md`（§x 指该计划）
> 前序交接：`2026-07-23-mixcut-phase0-handoff.md`（已被 phase1 文档取代）、`2026-07-24-mixcut-phase1-handoff.md`（停在 Phase 0→1 门禁，后续 7 个 Phase 于 7/24 当天完成，无单独交接文档）

## 1. 执行结论

8 个 Phase（0–7）全部在 worktree 分支 `mixcut-v1` 上实现完成（35 个 commit，+13889/−2546，129 文件），本评审后又追加修复 commit。分支已合并回 `mixcut01`。

评审方式：4 个只读审查子代理按 Phase 分组逐项核对计划/PRD 条款并给出 file:line 证据，主代理在 worktree 内独立实测全部门禁。

实测验证（合并前 worktree，Node v22.22.2）：

| 验证项 | 结果 |
|---|---|
| `scripts/*.test.ts` 全量 46 个文件 | 46/46 PASS（含 2 个新增） |
| `npm run lint` | 0 error（45 个 warning 均为既有 unused-vars 类） |
| `npm run build` | PASS（删除未提交原型后；删前必红，见 §3） |
| `scripts/final-edit-mixcut.playwright.test.mjs`（mock UI 回归） | PASS |
| `scripts/final-edit-mixcut-real.playwright.test.mjs`（真实项目 E2E：真实 ffmpeg 素材、真实 worker 渲染、组隔离、无黑场/冻结、artifacts、真实 ZIP） | PASS |

无证据项（不在本次收口范围）：macOS/Windows 真实安装包构建（PRD §10.6 部分）、PRD §10 的人工逐条验收。installer 已有脚本加固与静态断言（`macos-installer-payload.test.mjs` 需真实构建产物才有运行条件）。

## 2. 评审发现的偏差与逐项处置

### 已修复（本评审追加的 commit）

1. **§7.3 旋转信息缺失** — `probeVideoMedia` 原不读旋转。现 ffprobe 路径读 `stream_side_data=rotation` + legacy `rotate` tag，ffmpeg 回退路径解析 `rotate :`/`displaymatrix: rotation of`，±90/270° 时交换宽高，下游统一消费显示尺寸（`lib/ffmpeg.ts`）。测试 `scripts/probe-video-media.test.ts`（tkhd 矩阵手工改写 fixture，因本机 ffmpeg 6.0 的 `-metadata:s:v rotate=90` 不落 display matrix）。
2. **fallback 语义矩阵被永久缓存** — 原实现把 LLM 失败产生的 0.6 均匀矩阵写进缓存且无自愈。现 fallback 不写缓存、命中判断排除降级行，LLM 恢复后重跑自动重评并缓存成功矩阵（`lib/final-edit/workspace.ts`），`final-edit-workspace.test.ts` 断言改为「重试 → 自愈 → 缓存成功矩阵」。
3. **§10.5 字体不可审计** — 渲染快照新增 `textStyles`（含 fontFamily，旧快照恢复时可选缺失）；overlay manifest 记录 `fonts{primary,secondary,subtitle}`；字体扫描抽取为 `lib/final-edit/system-fonts.ts` 并在 API 响应中标记 `format:'ttc'`（`app/api/system-fonts/route.ts` 变薄壳）。测试 `scripts/final-edit-system-fonts.test.ts`。
4. **§11.4 tpad 未实现** — renderer 在 `[intro][body]concat` 后插入防御性 `tpad=stop_mode=clone:stop=0.5`，最终 `-t` 裁到精确时长；正常情况尾巴被完整裁掉不改变输出（`lib/final-edit/renderer.ts`）。`final-edit-render.test.ts`（真实 ffmpeg 渲染）回归通过。
5. **PRD §6 左辅栏缺「当前步骤概览/最近会话」** — `MixcutSidebar` 新增两个区块；会话列表来自既有 groups API（updatedAt DESC，点击切到对应分镜组），无新增后端接口（`components/mixcut/MixcutPanel.tsx`、`MixcutSidebar.tsx`、`MixcutPanel.module.css`）。
6. 小项：`final-edit-export-naming.test.ts` 文件头 Phase 0 红灯注释更新为契约保护说明；cover-frame 路由错误补齐 `{error, message}`（§6 约定）；`app/api/final-edit-groups/[id]/external-assets/` 空目录壳删除（实际路由在 shot-sets 作用域下，功能等价）。

### 确认接受（不修复，代码内已留 TODO）

7. **§7.4.2 成本函数第 5 条后半「相邻视觉重复惩罚」未实现** — 最小费用流的边成本逐句独立，相邻成对惩罚等价于二次分配问题，硬塞会破坏求解器纯函数结构。V1 接受：整体复用已有 λ=0.15 递增惩罚抑制。TODO 留在 `lib/final-edit/audio-first-matcher.ts`（附后续可选的确定性局部交换后处理方向）。
8. **§7.4.2 第 4 条「可用时长/裁剪损失」仅象征性权重** — 1:1 audio-first 段长恒定下裁剪损失难建模，V1 以 `quality*0.001` 微扰替代。同一 TODO 记录。

### 其他记录

- **外部素材路由偏差（计划 §6 → shot-sets 作用域）**：功能等价且更合理（导入发生在 group 创建前，归属仍由服务端从 DB 解析，敌意 FormData 有测试证明被忽略）。接受。
- **migration v4 跳号**：v4 曾在 worktree 内加入后被移除（索引改由核心迁移持有），未发布无实际影响，`final-edit-material-import.test.ts` 已反向钉住。
- **时间轴缺口可视化**：trim 缺口在轨道上是空白，显式性由预览「画面缺口」提示 + blocking issue `timeline_gap`（阻断导出）兜底。V1 接受。
- **CANDIDATE_WINDOW**：移植规格残留死参数，diagnostics 回声保留（信息性）。

## 3. 原型删除（§3.3 执行）

`app/mixcut-preview/` 与 `components/mixcut-prototype/` 从未提交（untracked），正式浏览器验收（两个 Playwright）已通过，删除条件满足，已在 worktree 与主仓库同步删除。删除前它们是 worktree `npm run build` 必红的唯一根因（硬编码 import `@/storage/...` 本地缩略图）；删除后构建通过。`components/mixcut/` 正式代码无任何 mock/假进度/原型引用（grep 验证）。

## 4. 合并与遗留

- `mixcut-v1` 合并回 `mixcut01`（fast-forward）。两份 PRD/计划/交接文档此前已提交进分支（`9f581b3` + 交接归档 commit），主仓库同名 untracked 副本内容一致，已在合并前移除避免冲突。
- worktree `.worktrees/mixcut-v1` 保留（含完整 `.next` 构建产物，真实 E2E 可直接重跑）；确认无需要后可 `git worktree remove`。
- 遗留无证据项：双平台真实安装包构建、PRD §10 人工验收——由主理人手工测试与下次打包验证覆盖。
