/**
 * B2/B3/B4 UI 契约（源码级断言，与仓库既有 *.ui-contract.test.mjs 同款）：
 * - B2：封面/预览的 URL 与 <img>/<video> key 带媒体代际（renderAttemptId / artifactId）；
 * - B3：导出页两套独立下载按钮（最新预览 vs 上次正式版），互不回退；
 * - B4：编辑器常驻"审核已重置"提示；面板失效选择列表 + 原始选择全部交服务端 + 结构化结果。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const editor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const panel = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');

// ---- B2:代际进 URL 与 key ----
// mediaUrlFn 按 source 写 renderAttemptId / artifactId
assert.match(review, /generation\) params\.set\(source === 'artifact' \? 'artifactId' : 'renderAttemptId', generation\)/);
// 卡片封面 <img> 与弹窗 <video> 的 key 必须含代际
assert.match(review, /<img[\s\S]*?key=\{`\$\{card\.planId\}-\$\{viewedVersionId\}-\$\{coverGeneration\}`\}/);
assert.match(review, /<video[\s\S]*?key=\{`\$\{modalCard\.planId\}-\$\{modalCard\.versionId\}-\$\{modalGeneration\}`\}/);
// 编辑器封面 URL 绑定上层传入的候选代际
assert.match(editor, /candidateRenderAttemptId\?: string \| null/);
assert.match(editor, /&renderAttemptId=\$\{encodeURIComponent\(candidateRenderAttemptId\)\}/);

// ---- B3:两套独立下载按钮 ----
assert.match(exportStep, /下载最新预览视频/);
assert.match(exportStep, /下载最新预览封面/);
assert.match(exportStep, /下载上次正式版视频/);
assert.match(exportStep, /下载上次正式版封面/);
// 最新预览只对"任务成功 + 生产就绪(card.publishable = candidate.productionReady) + 不 stale"开放
assert.match(exportStep, /const latestFresh = card\.task\?\.status === 'succeeded'/);
assert.match(exportStep, /&& card\.publishable/);
assert.match(exportStep, /!card\.renderStale/);
// 预览 <video> key 含代际
assert.match(exportStep, /key=\{`\$\{card\.planId\}-\$\{card\.versionId\}-\$\{previewGeneration\}`\}/);

// ---- B4:编辑清审核提示 + 面板信息链路 ----
assert.match(editor, /本次修改已重置审核状态；重新渲染完成后，请返回检查成片重新通过/);
assert.match(editor, /if \(editResult\.reviewCleared\) setReviewCleared\(true\)/);
// 后端原子返回 reviewCleared(路由透传,前端接收后驱动提示)
assert.match(editor, /editResult\.reviewCleared/);
// 失效选择列表:loadWorkspace 计算被移除的 planId 并常驻列出,不静默减少
assert.match(panel, /const \[selectionDropped, setSelectionDropped\] = useState/);
assert.match(panel, /以下成片已取消选择/);
// 原始选择全部交服务端复核:不再按 publishable/approved/renderStale 预过滤
assert.match(panel, /const planIdsToPublish = \[\.\.\.new Set\(selectedCards\.map\(\(\{ planId \}\) => planId\)\)\]/);
assert.doesNotMatch(panel, /\.filter\(\(card\) => card\.publishable && card\.approved && !card\.renderStale\)/, '导出不得在前端按新鲜度预过滤');
// 响应类型带 planId,结构化分栏展示
assert.match(panel, /items: Array<\{ planId: string; status: 'published' \| 'skipped'; reason\?: string; videoRelativePath\?: string \}>/);
assert.match(panel, /导出结果：成功 \{exportResult\.published\} 条/);
assert.match(panel, /成片 \{item\.seq != null \? String\(item\.seq\)\.padStart\(2, '0'\) : '--'\} · \{item\.title\}：\{item\.reason\}/);

console.log('batch output generation ui contract passed');
