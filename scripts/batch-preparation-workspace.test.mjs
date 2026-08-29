import assert from 'node:assert/strict';
import fs from 'node:fs';

const projectPage = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');
const workspace = fs.readFileSync('components/mixcut/MixcutWorkspace.tsx', 'utf8');
const preparation = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const materials = fs.readFileSync('components/batch-production/BatchStepMaterials.tsx', 'utf8');
const scripts = fs.readFileSync('components/batch-production/BatchStepScripts.tsx', 'utf8');
const progressCard = fs.readFileSync('components/batch-production/BatchProductionProgressCard.tsx', 'utf8');
const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const coverPreview = fs.readFileSync('components/batch-production/BatchCoverDraftPreview.tsx', 'utf8');
const outputEditor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const coverEditor = fs.readFileSync('components/batch-production/BatchCoverEditorDrawer.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const selectionCards = fs.readFileSync('components/batch-production/BatchInputSelectionCards.tsx', 'utf8');
const startRoute = fs.readFileSync('app/api/batch-production/batches/[id]/start/route.ts', 'utf8');
const scheduler = fs.readFileSync('lib/batch-production/scheduler.ts', 'utf8');

assert.match(projectPage, /MixcutWorkspace/);
assert.match(workspace, /单条精准混剪/);
assert.match(workspace, /批量生产/);
assert.match(workspace, /BatchPreparationPanel/);
assert.match(preparation, /\/api\/batch-production\/readiness/);
assert.match(preparation, /\/api\/batch-production\/prepare\?projectId=/);
assert.match(materials, /素材区/);
assert.match(scripts, /脚本与口播/);
assert.match(review, /检查成片/);
assert.match(review, /通过（/);
assert.match(review, /返工（/);
assert.match(review, /撤销审核/);
assert.match(exportStep, /导出成片/);
assert.match(preparation, /detail\.scriptSnapshots/);
assert.match(preparation, /inputState === 'frozen'/);
assert.match(preparation, /result\.inputState === 'frozen'/);
// 问题 4:单一分析入口 —— 只有「内容分析」按钮,基础分析入口已删除
assert.doesNotMatch(materials, /基础分析/);
assert.match(materials, /内容分析（/);
assert.match(materials, /内容分析模型/);
assert.match(materials, /一键全选/);
assert.match(materials, /取消全选/);
assert.match(preparation, /selectableAssetCards/);
// 第 1 步不再有固定高度内滚区(FR-S1-11 + 问题 3),素材列表在单一滚动容器内自然排布
assert.doesNotMatch(preparation, /h-\[820px\]/);
assert.doesNotMatch(materials, /h-\[620px\]/);
assert.doesNotMatch(materials, /h-\[clamp\(400px,56vh,760px\)\]/);
assert.doesNotMatch(preparation, /data-testid="batch-asset-pool-scroll"/);
assert.doesNotMatch(preparation, /data-testid="media-prep-asset-pool"/);
assert.doesNotMatch(preparation, /media-prep-asset-tile-/);
assert.match(materials, /aria-label="素材列表"/);
assert.match(materials, /sm:grid-cols-2 xl:grid-cols-3/);
assert.match(materials, /已锁定素材列表/);
assert.match(materials, /播放锁定素材/);
assert.match(preparation, /assets\/analyze\?projectId=/);
assert.match(preparation, /workType === 'asset_prepare'/);
assert.match(materials, /定位来源/);
assert.match(materials, /探测媒体/);
assert.match(preparation, /关闭素材预览/);
// 问题 3:画质与调色是工具行按钮 + 弹窗,不再常驻 section、不记忆展开状态
assert.doesNotMatch(materials, /batch-media-prep-open/);
assert.match(materials, /画质与调色（进阶）/);
assert.match(materials, /role="dialog"/);
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
// 封面标题预览可按脚本切换(2026-08-24):样式整批统一,但各脚本标题文字长短不一,
// 需要逐份核对入口,不再只能看「第一份已选脚本」。
assert.match(scripts, /预览脚本/);
assert.match(scripts, /aria-label="封面标题预览脚本"/);
assert.match(scripts, /coverPreviewScriptId/);
// 封面标题按脚本单独设置(2026-08-24):覆盖写入 defaultsJson 新字段,可恢复基准、可一键同步全部
assert.match(scripts, /coverTitleStylesByScript/);
assert.match(scripts, /恢复基准样式/);
assert.match(scripts, /已单独调整/);
assert.match(scripts, /applyCoverStyleToAllScripts/);
assert.match(scripts, /字幕样式/);
assert.match(scripts, /字幕样式调整目标/);
assert.match(preparation, /subtitleStylesByScript/);
// 「应用到全部脚本」会清掉其他脚本的单独调整:界面必须先报份数、再内联二次确认
assert.match(scripts, /份单独调整/);
assert.match(scripts, /确认清除其他/);
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
// 生产进度卡(FR-S2-30~34):抽成共享组件,统一渲染在第 2 步(full)与其他步骤(compact)顶部
assert.match(progressCard, /生产进度/);
assert.match(progressCard, /已用时/);
assert.match(progressCard, /已完成/);
assert.match(progressCard, /compact/);
assert.match(preparation, /BatchProductionProgressCard/);
// 进度卡批次控制(2026-08-23):full/compact 两个变体头部都能 暂停/继续/停止 批次,
// 已停止/已暂停有专属文案,卡住时不再只能干等。
assert.match(progressCard, /onControl/);
assert.match(progressCard, /暂停批次/);
assert.match(progressCard, /继续批次/);
assert.match(progressCard, /停止批次/);
assert.match(progressCard, /已停止/);
assert.match(scripts, /onControlBatch/);
assert.equal(
  preparation.match(/controlState=\{workspace\?\.batch\.controlState\}/g)?.length,
  2,
  '进度卡 full(BatchStepScripts)与 compact(容器)两处都必须传 controlState',
);
// 批次控制后补刷任务列表:停止后轮询即停,阶段列表要立刻落到 已停止/cancelled
assert.match(preparation, /Promise\.all\(\[loadWorkspace\(selectedBatchId\), loadTasks\(selectedBatchId\)\]\)/);
// 停止后再开跑(2026-08-23 反馈):显式开跑必须把 已停止/已暂停 批次重新激活,
// 否则语义门禁排队的任务永不被领取,界面呈现"已停止但进度条还在走"的僵尸态;
// 已停止批次的计时器不再空转。
assert.match(scheduler, /export function reactivateBatchForStart/);
assert.match(startRoute, /reactivateBatchForStart\(db, projectId, id\)/);
assert.match(preparation, /batchStopped/);
// 第 2 步顺序:脚本 → 背景音乐 → 输出设置(问题 2),BGM 必须在开始按钮之前
assert.ok(scripts.indexOf('renderBgmSection()') < scripts.indexOf('aria-label="输出设置与开始"'), 'BGM 区块必须在输出设置之前');
assert.match(scripts, /背景音乐在上方卡片中设置/);
assert.match(preparation, /锁定设置/);
assert.match(preparation, /自动配画面/);
assert.match(preparation, /生成口播/);
assert.match(preparation, /渲染成片/);
assert.match(preparation, /生成封面/);
// 第 3 步:按钮化操作 + 版本信息 + 历史版本切换(FR-S3-08/13/14/15)
assert.doesNotMatch(review, /只重新分配这一条/);
assert.match(review, /换一批画面/);
assert.match(review, /重试渲染/);
assert.match(review, /重新生成/);
assert.match(review, /重试配音/);
assert.match(review, /另有 .* 个历史版本/);
assert.match(review, /版本切换/);
assert.match(review, /查看版本/);
assert.match(review, /batch-output-cover-/);
assert.match(review, /subtitleCueCount/);
// 封面素材切换只保留在「调整片段」右侧设置,普通预览不再重复出现该编辑器
assert.doesNotMatch(review, /封面素材网格/);
assert.match(outputEditor, /BatchCoverEditorDrawer/);
assert.match(outputEditor, /lg:grid-cols-\[minmax\(246px,260px\)_minmax\(440px,1fr\)_minmax\(270px,300px\)\]/);
assert.match(outputEditor, /aria-label="素材调整"/);
assert.match(outputEditor, /aria-label="素材预览"/);
assert.match(outputEditor, /aria-label="成片设置"/);
assert.match(outputEditor, /data-testid="batch-output-preview-pane"/);
assert.match(outputEditor, /data-testid="batch-output-timeline-pane"/);
assert.match(coverEditor, /data-testid="batch-cover-editor-drawer"/);
assert.match(coverEditor, /封面截帧时间/);
assert.match(coverPreview, /封面实时预览/);
assert.match(review, /手动字幕覆盖/);
assert.doesNotMatch(outputEditor, /口播变速/);
assert.doesNotMatch(outputEditor, /跳转到脚本步骤/);
assert.match(exportStep, /打开文件夹/);
assert.match(exportStep, /已导出/);
assert.match(selectionCards, /thumbnailUrl/);
assert.match(selectionCards, /previewUrl/);
assert.match(selectionCards, /开始内容分析/);
assert.match(selectionCards, /内容分析可用/);
assert.match(selectionCards, /补充内容分析/);
assert.match(selectionCards, /重试/);
assert.match(selectionCards, /缩略图暂不可用/);
assert.match(selectionCards, /已锁定的脚本快照/);
assert.match(selectionCards, /bodyText/);

console.log('batch preparation workspace contract tests passed');
