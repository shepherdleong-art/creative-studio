import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync(new URL('../components/script-studio/ScriptStudioPanel.tsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../app/projects/[id]/page.tsx', import.meta.url), 'utf8');
const taskRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/route.ts', import.meta.url), 'utf8');
const retryRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/[taskId]/retry/route.ts', import.meta.url), 'utf8');
const regenerateRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/scripts/[scriptId]/regenerate/route.ts', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../lib/script-studio/runtime.ts', import.meta.url), 'utf8');
const tasksModule = fs.readFileSync(new URL('../lib/script-studio/tasks.ts', import.meta.url), 'utf8');

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

console.log('script-studio UI contract tests passed');
