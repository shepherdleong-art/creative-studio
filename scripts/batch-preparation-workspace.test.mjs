import assert from 'node:assert/strict';
import fs from 'node:fs';

const projectPage = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');
const workspace = fs.readFileSync('components/mixcut/MixcutWorkspace.tsx', 'utf8');
const preparation = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const materials = fs.readFileSync('components/batch-production/BatchStepMaterials.tsx', 'utf8');
const scripts = fs.readFileSync('components/batch-production/BatchStepScripts.tsx', 'utf8');
const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const selectionCards = fs.readFileSync('components/batch-production/BatchInputSelectionCards.tsx', 'utf8');

assert.match(projectPage, /MixcutWorkspace/);
assert.match(workspace, /单条精准混剪/);
assert.match(workspace, /批量生产/);
assert.match(workspace, /BatchPreparationPanel/);
assert.match(preparation, /\/api\/batch-production\/readiness/);
assert.match(preparation, /\/api\/batch-production\/prepare\?projectId=/);
assert.match(materials, /素材区/);
assert.match(scripts, /脚本与口播/);
assert.match(review, /批次成片工作区/);
assert.match(exportStep, /导出成片/);
assert.match(preparation, /detail\.scriptSnapshots/);
assert.match(preparation, /inputState === 'frozen'/);
assert.match(preparation, /result\.inputState === 'frozen'/);
assert.match(materials, /基础分析/);
assert.match(materials, /内容分析待补齐/);
assert.match(materials, /内容分析模型/);
assert.match(materials, /一键全选/);
assert.match(materials, /取消全选/);
assert.match(preparation, /selectableAssetCards/);
// 第 1 步不再有固定高度内滚区(FR-S1-11),素材列表在单一滚动容器内自然排布
assert.doesNotMatch(preparation, /h-\[820px\]/);
assert.doesNotMatch(materials, /h-\[620px\]/);
assert.doesNotMatch(preparation, /data-testid="batch-asset-pool-scroll"/);
assert.doesNotMatch(preparation, /data-testid="media-prep-asset-pool"/);
assert.doesNotMatch(preparation, /media-prep-asset-tile-/);
assert.match(materials, /aria-label="素材列表"/);
assert.match(materials, /overscroll-contain/);
assert.match(preparation, /assets\/analyze\?projectId=/);
assert.match(preparation, /workType === 'asset_prepare'/);
assert.match(materials, /定位来源/);
assert.match(materials, /探测媒体/);
assert.match(preparation, /关闭素材预览/);
// 画质与调色默认收起,展开状态记忆到本地(FR-S1-07/AC-S1)
assert.match(materials, /batch-media-prep-open/);
assert.match(materials, /画质与调色（进阶）/);
// 分析模型选择持久化 + 供应商·模型 下拉 + 无视觉供应商引导(FR-S1-05a/05b/05c/05d)
assert.match(preparation, /batch-vision-provider/);
assert.match(materials, /\.name\} · \{provider\.model\}/);
assert.match(materials, /没有开启图片理解的供应商/);
// 第 2 步:时长只读、份数、配音配置、确认与开始(FR-S2-20/20a/20b/22)
assert.match(scripts, /（默认 15 秒）/);
assert.match(scripts, /生成份数/);
assert.match(scripts, /配音服务商/);
assert.match(scripts, /语速/);
assert.match(scripts, /应用到全部脚本/);
assert.match(scripts, /narration-config/);
assert.match(scripts, /确认整体输入/);
assert.match(scripts, /开始批量生产/);
assert.match(scripts, /配音供应商/);
// BGM 参数整批统一可调(FR-S2-45):音量/淡入/淡出 滑杆带可读 aria 标签
assert.match(scripts, /背景音乐音量增益/);
assert.match(scripts, /背景音乐淡入/);
assert.match(scripts, /背景音乐淡出/);
// BGM 曲库区(FR-S2-40/41/42/44/47):空曲库提示 + 重新扫描 + 手动指定
assert.match(scripts, /曲库为空 —— 请把音频文件放进 storage\/bgm\//);
assert.match(scripts, /重新扫描/);
assert.match(scripts, /曲目（可手动指定）/);
assert.match(scripts, /手动指定/);
assert.match(scripts, /成片将自动分配/);
// 生产进度卡(FR-S2-30~34):阶段标签在状态容器里计算
assert.match(scripts, /生产进度/);
assert.match(scripts, /已用时/);
assert.match(preparation, /锁定设置/);
assert.match(preparation, /自动配画面/);
assert.match(preparation, /生成口播/);
assert.match(preparation, /渲染成片/);
assert.match(preparation, /生成封面/);
// 第 3 步:按钮化操作 + 版本信息 + 历史版本切换(FR-S3-08/13/14/15)
assert.doesNotMatch(review, /只重新分配这一条/);
assert.match(review, /换一批画面/);
assert.match(review, /重新渲染/);
assert.match(review, /另有 .* 个历史版本/);
assert.match(review, /版本切换/);
assert.match(review, /查看版本/);
assert.match(review, /batch-output-cover-/);
assert.match(review, /subtitleCueCount/);
// 第 1 步:素材池自适应固定高度(clamp,不再 min-h + flex-1 混用) + 响应式列数 + 锁定后缩略图网格(FR-S1-11, 问题 1/2-B)
assert.match(materials, /h-\[clamp\(400px,56vh,760px\)\]/);
assert.match(materials, /sm:grid-cols-2 xl:grid-cols-3/);
assert.match(materials, /已锁定素材列表/);
assert.match(materials, /播放锁定素材/);
assert.match(exportStep, /打开文件夹/);
assert.match(exportStep, /已导出/);
assert.match(selectionCards, /thumbnailUrl/);
assert.match(selectionCards, /previewUrl/);
assert.match(selectionCards, /开始分析/);
assert.match(selectionCards, /基础分析可用/);
assert.match(selectionCards, /补充内容分析/);
assert.match(selectionCards, /重试/);
assert.match(selectionCards, /缩略图暂不可用/);
assert.match(selectionCards, /已锁定的脚本快照/);
assert.match(selectionCards, /bodyText/);

console.log('batch preparation workspace contract tests passed');
