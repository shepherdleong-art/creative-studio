import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(
  new URL('../components/VideoGenerationPanel.tsx', import.meta.url),
  'utf8',
);
const results = readFileSync(
  new URL('../components/VideoGenerationResults.tsx', import.meta.url),
  'utf8',
);

assert.match(
  panel,
  /from ['"]@\/components\/video-bulk-prompt['"]/,
  '面板必须从纯逻辑模块导入批量决策函数',
);
assert.match(panel, /planBulkPromptFill/);
assert.match(panel, /planBulkVideoGeneration/);
assert.doesNotMatch(panel, /Math\.random\s*\(/, '面板不得自行挑选随机模板');
assert.match(panel, /const perShotMotionCache = useRef/);

const generateStart = panel.indexOf('const handleGenerateAll');
const generateEnd = panel.indexOf('const handleOpenBulkDrawer', generateStart);
assert.notEqual(generateStart, -1, '面板必须提供全部生成动作');
assert.notEqual(generateEnd, -1, '全部生成动作必须有明确的结束边界');
const generateBlock = panel.slice(generateStart, generateEnd);
const confirmIndex = generateBlock.indexOf('bulkConfirmText');
const fetchIndex = generateBlock.indexOf("video-jobs/batch");
assert.notEqual(confirmIndex, -1, '批量提交前必须有确认关口');
assert.notEqual(fetchIndex, -1, '批量生成必须调用现有按分镜 batch 接口');
assert.ok(confirmIndex < fetchIndex, '确认关口必须出现在批量请求之前');
assert.doesNotMatch(
  generateBlock,
  /window\.confirm/,
  '批量确认不得用 window.confirm：同步原生弹窗会吞掉 mouseup，之后原生 select 下拉点不开，必须切走再切回应用才恢复',
);
assert.match(generateBlock, /setBulkStatus/);
assert.match(generateBlock, /BULK_CONFIRM_THRESHOLD/);
assert.match(
  generateBlock,
  /safeShots\.length >= BULK_CONFIRM_THRESHOLD[\s\S]*plan\.totalClips >= BULK_CONFIRM_THRESHOLD/,
  '批量确认必须同时覆盖分镜少但提交条数多的情况',
);
assert.doesNotMatch(generateBlock, /\balert\s*\(/, '批量结果不得用 alert 短暂弹出');

const toolbarStart = panel.indexOf('className="video-bulk-toolbar"');
assert.notEqual(toolbarStart, -1, '批量工具栏必须有明确入口');
const toolbar = panel.slice(toolbarStart, toolbarStart + 900);
assert.doesNotMatch(toolbar, /handleBulkFillPrompts/, '外层工具栏不得重复提供一键填充提示词');

const drawerStart = panel.indexOf('className="video-bulk-drawer"');
const drawerEnd = panel.indexOf('className="video-bulk-status-bar"', drawerStart);
assert.notEqual(drawerStart, -1, '必须有覆盖工作区的批量检查抽屉');
assert.notEqual(drawerEnd, -1, '批量检查抽屉必须有结束边界');
const drawer = panel.slice(drawerStart, drawerEnd);
assert.match(drawer, /HoverZoomImage/);
assert.match(drawer, /updateBulkRowTemplate/);
assert.match(drawer, /updateBulkRowPrompt/);
assert.match(drawer, /updateBulkRowDuration/);
assert.match(drawer, /getVideoMotionRowIssue/);
assert.match(drawer, /已有视频/);
assert.match(drawer, /未填写/);
assert.match(drawer, /手写已锁定/);
assert.match(drawer, /带尾帧/);
assert.match(drawer, /handleBulkFillPrompts/, '一键填充提示词必须保留在批量检查抽屉内');
assert.doesNotMatch(drawer, /handleTailFrameUpload|handleTailFrameRemove/, '检查列表不得编辑尾帧');

const editStart = panel.indexOf('const updateBulkRowPrompt');
const editEnd = panel.indexOf('const applyBulkProvider', editStart);
assert.notEqual(editStart, -1, '批量提示词编辑必须有独立写回函数');
assert.notEqual(editEnd, -1, '批量编辑写回函数必须有明确边界');
assert.match(panel.slice(editStart, editEnd), /setShotRows/);

assert.match(panel, /video-bulk-status-bar/);
assert.match(panel, /bulkProgress/);

const videoJobRoute = readFileSync(
  new URL('../app/api/video-jobs/[id]/route.ts', import.meta.url),
  'utf8',
);
assert.match(videoJobRoute, /body\.action === ['"]reject['"] \|\| body\.action === ['"]unreject['"]/);
assert.match(videoJobRoute, /status !== ['"]succeeded['"]/);
assert.match(videoJobRoute, /rejectedAt = datetime\(['"]now['"]\)/);
assert.match(videoJobRoute, /rejectedAt = NULL, rejectReason = NULL/);
assert.match(videoJobRoute, /slice\(0, 500\)/);
assert.match(panel, /JSON\.stringify\(\{ action: ['"]reject['"], reason:/, '剔除请求必须把可选原因传给服务端');
assert.match(results, /placeholder="剔除原因（可选）"/);
assert.match(results, /onReject\(jobId, rejectReasonDraft\.trim\(\) \|\| undefined\)/);

// C5（D5）：友好名称展示契约——结果卡显示 displayName，播放 URL 仍用物理
// filename，下载建议文件名为 displayName。
assert.match(results, /result-name/, '结果卡必须显示友好名称行');
assert.match(results, /download=\{job\.displayName \|\| job\.filename\}/, '下载建议文件名必须优先 displayName');
assert.match(panel, /displayName\?: string \| null/, '面板任务类型必须携带 displayName');

// 排序契约（对齐 C4「状态不参与位置计算」）：结果卡必须保留列表 API 的
// 入参顺序（createdAt DESC, rowid ASC），不得按任务状态重排——否则批内
// V01→V02→V03 会随任务陆续完成而跳位。
assert.doesNotMatch(
  results,
  /\.sort\(/,
  '结果卡不得重排列表 API 顺序：状态排序会让卡片随任务状态跳位',
);

// 抽屉必须 portal 到 body，且这条约束的成因要能被验证：
// .video-generation-section 用 transform 做全宽布局，transform 会给后代的
// position: fixed 造包含块，抽屉留在原地就会被按进页面流，笔记本视口下
// 底部的「全部生成」会掉到屏幕外。只要那个 transform 还在，portal 就不能撤。
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
assert.match(
  css,
  /\.video-generation-section\s*\{[^}]*transform:\s*translateX\(-50%\)/s,
  '全宽布局仍依赖 transform，下面的 portal 约束因此仍然必要',
);
assert.match(
  css,
  /\.video-bulk-drawer\s*\{[^}]*position:\s*fixed/s,
  '批量抽屉必须是视口固定的遮罩层',
);
assert.match(panel, /createPortal/, '批量抽屉必须通过 portal 渲染');
assert.match(
  panel,
  /createPortal\(\([\s\S]*?video-bulk-drawer[\s\S]*?\), document\.body\)/,
  '批量抽屉必须 portal 到 document.body，才能逃出被 transform 的祖先',
);

console.log('video bulk prompt UI contract tests passed');
