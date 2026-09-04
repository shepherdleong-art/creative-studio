/**
 * 成片生成 UI 契约（源码级断言，与仓库既有 *.ui-contract.test.mjs 同款）。
 * 编辑器优先模型（2026-09）：
 * - 检查页点卡片直接进编辑器,封面 <img> 的 key 带封面尝试代际;
 * - 导出页只绑定 currentFormalArtifact:播放器 key 含 artifactId,下载只有当前正式版;
 * - 编辑清审核提示;面板失效选择列表 + 选择全部交服务端复核 + 结构化结果 + 同页自动续跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const editor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const panel = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const exportsRoute = fs.readFileSync('app/api/batch-production/batches/[id]/exports/route.ts', 'utf8');
const clipsRoute = fs.readFileSync('app/api/batch-production/batches/[id]/outputs/[planId]/clips/route.ts', 'utf8');
const orchestrator = fs.readFileSync('lib/batch-production/export-orchestrator.ts', 'utf8');

// ---- 编排与路由边界:唤醒下沉,路由只调用统一入口 ----
assert.doesNotMatch(exportsRoute, /ensureBatchSchedulerStarted/, '调度器唤醒必须下沉进编排模块,路由不得再直接唤醒');
assert.match(orchestrator, /wakeScheduler/, '编排模块必须拥有唤醒能力(默认懒加载 bootstrap,可注入 seam)');
// 封面任务只在前后封面契约真的变化时安排:BGM/字幕/音量等 visualChanged 编辑不得触发
assert.match(clipsRoute, /coverContractBefore === null \|\| coverContractAfter === null \|\| coverContractBefore !== coverContractAfter/, '普通编辑不得重做封面,只有契约变化才排封面任务');
assert.match(clipsRoute, /resolveCoverContractHash/, '封面契约变化必须用统一哈希判断');

// ---- 检查页:封面墙代际 + 直接进编辑器 ----
assert.match(review, /coverAttemptId/, '封面墙媒体按封面尝试代际取源');
assert.match(review, /key=\{`\$\{card\.planId\}-\$\{card\.coverAttemptId\}`\}/, '封面 img key 必须含封面尝试代际');
assert.match(review, /setEditorCard\(card\)/, '点卡片直接进入编辑器');
assert.doesNotMatch(review, /<video/, '检查页不再有渲染视频播放器');
assert.match(editor, /candidateRenderAttemptId\?: string \| null/);
assert.match(editor, /&renderAttemptId=\$\{encodeURIComponent\(candidateRenderAttemptId\)\}/, '编辑器封面预览绑定封面尝试代际');

// ---- 导出页:播放器与下载只绑定当前正式 artifact ----
assert.match(exportStep, /const formal = card\.currentFormalArtifact/, '播放源只绑定当前正式成片');
assert.match(exportStep, /key=\{`\$\{card\.planId\}-\$\{formal\.video\.id\}`\}/, '播放器 key 必须含 artifactId,换源才生效');
assert.match(exportStep, /下载当前正式版视频/);
assert.match(exportStep, /下载当前正式版封面/);
assert.doesNotMatch(exportStep, /下载最新预览|下载上次正式版/, '旧的两套下载入口必须移除');
assert.doesNotMatch(exportStep, /candidate\b/, '导出页不得再引用渲染候选');
assert.match(exportStep, /formalOutdated/, '返工期间必须提示当前修改尚未导出');
assert.match(exportStep, /正在渲染成片/, '首次导出显示渲染进度');
assert.match(exportStep, /重试导出/);
// 正式导出状态只消费服务端 exportStatus,前端不再从 fullRenderTask 自行拼状态
assert.match(exportStep, /card\.exportStatus === 'rendering'/, '渲染状态必须来自 exportStatus');
assert.match(exportStep, /card\.exportStatus === 'failed'/, '失败状态必须来自 exportStatus');
assert.doesNotMatch(exportStep, /fullRenderTask\?\.status === 'queued'/, '不得再从前端拼 queued 渲染状态');
// 首次导出失败(尚无正式成片)也必须给恢复入口:重试/回检查按钮不得藏在 formal 条件内
assert.match(exportStep, /\{exportFailed && \(\s*\n\s*<div className="flex flex-wrap gap-2">\s*\n\s*<button/, '重试导出按钮必须由 exportStatus===failed 门控,而不是 formal');
assert.match(exportStep, /\{exportFailed && \([\s\S]*?回检查成片修改/, '回检查入口与重试同块,首次导出失败也可用');
assert.match(exportStep, /onRetryExport\(card\.planId, card\.fullRenderTask\.id\)/, '重试必须带上 planId');
// 页面承诺必须诚实:关闭/刷新后需再点一次导出
assert.match(exportStep, /关闭或刷新了页面，重新进入后需要再点一次「导出」/, '渲染中提示必须说明关闭/刷新后要再点一次导出');

// ---- 编辑清审核提示 ----
assert.match(editor, /本次修改已重置审核状态；请返回检查成片重新通过/);
assert.match(editor, /if \(editResult\.reviewCleared\) setReviewCleared\(true\)/);
assert.match(editor, /editResult\.reviewCleared/);

// ---- 面板信息链路 ----
assert.match(panel, /const \[selectionDropped, setSelectionDropped\] = useState/);
assert.match(panel, /以下成片已取消选择/);
// 原始选择全部交服务端复核:不再按 publishable/approved/renderStale 预过滤
assert.doesNotMatch(panel, /\.filter\(\(card\) => card\.publishable && card\.approved && !card\.renderStale\)/, '导出不得在前端按新鲜度预过滤');
assert.doesNotMatch(panel, /\.filter\(\(\{ publishable, renderStale \}\)/);
assert.match(panel, /render_queued' \| 'rendering' \| 'render_failed' \| 'already_published' \| 'published'/, '响应状态必须消费编排器新状态');
assert.match(panel, /pendingAutoExportRef/, '同页轮询到渲染完成后自动续跑发布');
assert.match(panel, /publishPlans\(\[planId\]\)/, '渲染失败重试必须只发布该计划:刷新后选择集为空也必须能完成发布');
assert.match(panel, /alreadyPublished \?\? 0/, '幂等命中按已导出口径反馈');
assert.match(panel, /导出结果：成功 \{exportResult\.published\} 条/);
assert.match(panel, /成片 \{item\.seq != null \? String\(item\.seq\)\.padStart\(2, '0'\) : '--'\} · \{item\.title\}：\{item\.reason\}/);

console.log('batch output generation ui contract passed');