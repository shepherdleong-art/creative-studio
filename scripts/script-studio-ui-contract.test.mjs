import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync(new URL('../components/script-studio/ScriptStudioPanel.tsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../app/projects/[id]/page.tsx', import.meta.url), 'utf8');
const taskRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/route.ts', import.meta.url), 'utf8');
const retryRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/[taskId]/retry/route.ts', import.meta.url), 'utf8');
const regenerateRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/scripts/[scriptId]/regenerate/route.ts', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../lib/script-studio/runtime.ts', import.meta.url), 'utf8');
const tasksModule = fs.readFileSync(new URL('../lib/script-studio/tasks.ts', import.meta.url), 'utf8');
const templatePicker = fs.readFileSync(new URL('../components/script-studio/TemplateRewritePicker.tsx', import.meta.url), 'utf8');
const viralSettings = fs.readFileSync(new URL('../components/script-studio/ViralTemplateSettings.tsx', import.meta.url), 'utf8');

function assertSchedulerRefreshesBeforeEnqueue(source, label) {
  const ensureAt = source.indexOf('await ensureScriptStudioSchedulerStarted()');
  const createAt = source.indexOf('const created = createTask');
  assert.ok(ensureAt >= 0 && createAt >= 0 && ensureAt < createAt, `${label} 必须先刷新调度器执行器，再把任务写成 queued`);
}

assert.match(panel, /详情页智能脚本生成/, '第三步主入口必须显示新流程标题');
assert.match(panel, /分析并生成脚本/, '主按钮必须为一次点击的分析并生成');
assert.match(panel, /script-studio\/source-sets/, '必须创建详情页来源集');
assert.match(panel, /script-studio\/tasks/, '必须创建持久化生成任务');
assert.match(panel, /script-studio\/scripts/, '必须分页读取项目脚本');
assert.match(panel, /useState\(15\)/, '目标时长默认应为 15 秒');
assert.match(panel, /useState\(3\)/, '默认应生成 3 条并列方案');
// F1：生成数量上限集中在共享契约,UI 使用共享 options 而不是再抄一份数组。
assert.match(panel, /SCRIPT_GENERATION_UI_OPTIONS\.map/, 'UI 必须使用共享生成数量选项');
assert.doesNotMatch(panel, /\[1, 2, 3, 5\]\.map/, '不得再复制旧的上限数组');
assert.doesNotMatch(panel, /\[1, 2, 3, 5, 6\]\.map/, '不得在组件里另抄一份新上限数组');
assert.match(taskRoute, /parseScriptStudioRequestedCount/, 'route 必须使用共享数量契约');
assert.match(taskRoute, /parseScriptStudioTargetDuration/, 'route 必须使用共享时长契约');
assert.match(panel, /creativeBrief/, '必须提供可选创作要求');
assert.match(panel, /data-testid="script-studio-upload-dropzone"/, '空素材区必须是整块可点击上传框');
assert.match(panel, /拖拽图片到此处，或点击选择/, '上传框必须明确支持拖拽与点击选择');
assert.match(panel, /脚本模型/, '必须提供任务级脚本模型选择');
assert.match(panel, /需要公司内网/, '公司 Luna 必须明确标注需要公司内网');
assert.match(panel, /fetch\('\/api\/providers\/script'/, '模型选择必须读取真实脚本供应商配置');
assert.match(panel, /providerId,/, '创建任务时必须提交用户显式选择的模型');
assert.match(panel, /使用本次模型重试/, '完全失败任务必须能直接按任务快照中的模型重试');
assert.match(panel, /版本历史/, '每个方案必须提供版本历史');
assert.match(panel, /再生成一版/, '每个方案必须提供再生成一版');
assert.match(panel, /再生成只复用卖点库，不重新识图/, '「再生成只复用卖点库」文案是正确语义,不得删除');
// F2：再生成一组 = 每次全新的显式 key + 冻结完整 POST body + 同步 in-flight guard + 不确定结果可重试。
assert.match(panel, /regenerate-group:\$\{crypto\.randomUUID\(\)\}/, '每次再生成必须用全新的显式 key');
assert.match(panel, /pendingRegenerationRef\.current = \{/, '必须冻结不可变的 action（requestKey + 完整 body）');
assert.match(panel, /inFlightRegenerationRef/, '必须用同步 in-flight guard 挡极速双击');
assert.match(panel, /重试本次提交/, '结果不确定时必须呈现「重试本次提交」');
assert.match(panel, /regenerateDuration/, '再生成一组可单独指定本次秒数');
assert.match(panel, /regenerateCount/, '再生成一组可单独指定本次条数');
assert.match(panel, /保存为新版本/, '人工编辑必须保存为新版本');
assert.doesNotMatch(panel, /采用版本|取消采用|进入智能混剪/, '结果页不得出现采用/取消采用/强制进入混剪');
assert.doesNotMatch(panel, /分镜组|手填卖点|选模板/, '第三步不得再并排展示旧分镜、手填卖点和模板入口');
assert.match(page, /ScriptStudioPanel/, '项目工作台必须挂载新流程');
assert.doesNotMatch(page, /activeTab === 'script'.*ScriptPanel/, '旧 ScriptPanel 不得再作为主入口挂载');
assert.match(taskRoute, /decideTaskRequest\(/, '任务创建必须走共享幂等决策');
assert.match(taskRoute, /}, resolveRuntimeProviders\)/, '创建新任务时须把显式选择的模型解析器作为回调传入 decideTaskRequest 校验');
assert.match(tasksModule, /providerModel: pv\.model/, '任务快照必须保存实际模型名以便审计');
assert.match(runtime, /inputSnapshot\.providerId/, '任务执行必须使用快照中的模型选择');
assert.match(retryRoute, /savedLibraryRevisionId \? 'reuse' : parent\.mode/, '卖点库尚未保存的首次提取失败必须按原模式重跑，不能误走复用模式');
assertSchedulerRefreshesBeforeEnqueue(taskRoute, '首次生成');
assertSchedulerRefreshesBeforeEnqueue(retryRoute, '失败补跑');
assertSchedulerRefreshesBeforeEnqueue(regenerateRoute, '单条再生成');

// 2026-09-15 用户调整：默认直用事实，只保留可选的保留/排除入口。
assert.doesNotMatch(panel, /DistilledPointsSection|确认可用|待确认/, '不再挂载第二份待确认卖点列表');
assert.match(panel, /选择 \/ 排除卖点/, '保留可选选择入口');
assert.doesNotMatch(runtime, /createSellingPointDistiller/, '默认运行链路不能再调用额外提炼模型');
assert.match(panel, /disabledByUser: !event.target.checked/, '排除与重新保留都应写入人工选择');
// 审查 R2：三类状态分开显示——结尾检查与语义审核各自独立展示，未审核不得显示整体文案合格。
assert.match(panel, /结尾检查通过/, '结尾检查状态必须独立展示');
assert.match(panel, /语义审核通过/, '语义审核通过状态必须展示');
assert.match(panel, /语义审核未执行/, '语义审核未执行必须如实展示，不得补成合格');

// 2026-09-17 爆文模板改写（迁移方案 A03/A14）：模式入口、勾选数量语义与诚实展示。
assert.match(panel, /爆文模板改写/, '生产模式必须提供爆文模板改写入口');
assert.match(panel, /TemplateRewritePicker/, '必须挂载模板勾选组件');
assert.match(panel, /templateEntryIds/, '创建任务必须提交勾选的模板条目');
assert.match(panel, /写作估算 ≈ \{targetDurationSec \* 6\} 中文字\/条（±15%，不代表实际配音时长）/, '字数估算必须明示不代表实测配音时长');
assert.match(panel, /结构：\{meta\.structureOrigin === 'fallback' \? '默认（表格未提供）' : '模板表格'\}/, '缺失结构必须如实标默认，不得显示成已精细分析');
assert.match(panel, /未生成修改说明。/, '修改说明缺失必须如实展示，不得伪造');
assert.match(panel, /模型自述，非证据审核/, '修改说明必须标注为模型自述而非证据审核');
assert.match(panel, /这只是文字差异对照，不是原创率或合规证明/, '文字差异不得显示为原创率');
assert.doesNotMatch(panel, /原创率\s*[:：]|原创率\s*\d|爆款概率|转化率\s*[:：]/, '不得杜撰原创率/爆款概率/转化率指标');

// 2026-09-17 流程修正 v2（用户反馈）：爆文模板改写三步流转——
// 第 1 步分析建库（extractOnly 前置任务）→ 第 2 步挑选模板（每模板可选多条变体）→ 第 3 步卖点+脚本。
assert.match(panel, /分析详情页，提取卖点/, '无卖点库时必须提供一键提取卖点入口');
assert.match(panel, /extractOnly: true/, '一键提取必须向服务端提交 extractOnly 标记');
assert.match(panel, /卖点库已建好，请在下方挑选爆文模板并选择每个模板生成几条/, '建库完成后必须引导到第 2 步挑选模板');
assert.match(panel, /仅提取卖点建库，不生成脚本/, '过程页阶段必须如实标注仅提取、不生成');
assert.match(panel, /extractOnlyTask \? 6/, '仅提取任务包含事实组织，共 6 个阶段');
assert.match(panel, /下一步：挑选爆文模板/, '已有卖点库时第 1 步必须直达第 2 步挑选模板');
assert.match(panel, /第 2 步挑选爆文模板时决定/, '第 1 步不得再内嵌勾选区，生成数量由第 2 步决定');
assert.match(panel, /共 \$\{templateEntryIds\.length\} 条/, '第 2 步提交按钮必须明示模板数与总条数');
assert.match(panel, /每个模板可选生成 1 条或多条变体/, '必须如实说明同一模板可生成多条变体');
assert.match(templatePicker, /增加「/, '每个已选模板必须能增加生成条数');
assert.match(templatePicker, /同一模板多条生成不同变体/, '勾选计数必须如实说明变体语义');
assert.match(taskRoute, /body\.extractOnly === true/, 'route 必须解析 extractOnly 标记');
assert.match(taskRoute, /仅提取卖点库需要先上传详情页图片/, 'route 必须校验仅提取任务带详情页来源集');
assert.match(templatePicker, /还没有卖点库。确认已添加详情页后，点击下方「分析详情页，提取卖点」/, '无卖点库必须给出下一步操作指引');
assert.match(templatePicker, /爆文模板库还是空的：请先到「设置 → 脚本知识与模板 → 爆文模板库」导入/, '模板库未导入时必须指引到设置页');
assert.doesNotMatch(templatePicker, /需要先有卖点库（从详情页提取或复用已有）/, '旧的无指引死胡同提示必须移除');
assert.match(viralSettings, /强尼精选爆文文案/, '爆文模板库必须标注为强尼精选');
assert.doesNotMatch(viralSettings, /同事整理/, '不得再出现同事整理字样');

// 2026-09-18 用户要求交付完整「核心卖点＋详解」，核验后的事实需全局组织。
assert.match(panel, /organize: '整理核心卖点与详解'/);
assert.match(panel, /first_extraction: 10/);
assert.match(panel, /查看支撑事实与来源/);
assert.match(panel, /个有效卖点 · V/, '计数按组织后的有效卖点统计');
assert.match(panel, /无详解（模板改写不可用）/, '缺详解小点必须如实标注模板改写不可用');
console.log('script-studio UI contract tests passed');
