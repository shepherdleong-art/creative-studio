import { getDb } from '../db.ts';
import { executeScriptStudioTask } from './runner.ts';
import { createRuntimeDeps } from './runtime.ts';
import { getScriptStudioReadiness, scriptStudioReadinessUnavailable } from './runtime-readiness.ts';
import {
  getScriptStudioSchedulerController,
  recoverScriptStudioTasks,
  SCRIPT_STUDIO_SCHEDULER_KEY,
  startScriptStudioScheduler,
  type ScriptStudioSchedulerController,
} from './scheduler.ts';

// Next dev 热更新会保留 globalThis，但旧调度器的 executor 闭包不会自动换成新代码。
// 任何改变任务实际供应商/执行语义的修改都必须递增此版本，使旧闭包先停再换。
// v7：runner 执行语义变更——卖点库修订在任务创建时冻结（不再执行时读当前版）、
// 知识推荐真正按证据卖点类型评分并写入方向卖点包（详见任务快照/知识上下文改动）。
// v8：标题埋词计数口径变更（有效词过滤 + 同词根包含去重）与校验反馈人话化。
// v9：跨商品保护判定口径变更——只把「商品名都识别出来且明显不同」当作冲突，
// 消除同一产品多页详情图逐页提取措辞差异造成的误阻断。
// v10：型号/展示名称/搜索词分离，项目近期标题去重与仅标题有界修复。
// v11：跨页身份判定结合来源集分段文件名与品牌/品类/型号证据，且提取失败保留诊断载荷。
// v12：封面主副标题按完整组合去重，允许展示名称主标题复用，并拦截副标题词序调换。
// v13：移除「标签补字」本地兜底（extendScriptContentToDuration），改为受约束正文修复；
//      时长改为软目标（不再因字数阻断保存），新增 CTA 结尾检查、请求预算计数与框架秒数适配。
// v14：新增结尾语义审核（reviewScriptContent，严格解析子检查）、提炼阶段取消信号贯通、
//      提炼卖点不可变编辑版本链与逐字段限定核验（规则版本 distill-rules-v2）。
// v15：合格方案逐条保存、按方向恢复；审核修复失败不再整篇重写循环。
// v16：默认直接使用提取事实，取消额外提炼；多页提取共享并发队列。
// v17：CTA 链接落版合法化（cta-ending-v3）+ 受众画像进 plan 阶段（audience-profile-v1，
//      模型分析/本地降级、画像绑定方向并参与卖点编排排序，失败不阻塞任务）。
// v18：痛点解决型 15 秒模式（pain_solving_15s）：内容机会规划、三子路径、
//      机会不足不凑数（shortageCount 不计失败）。
// v19：爆文模板改写模式（template_rewrite）：模板全文快照进任务身份、按模板筛选白名单、
//      文风预设/风格分析、改写与后处理链（字数修正带当前稿、残留校验、修改说明）。
// v20：移除卖点主题归纳（aggregate 阶段与大点持久化）——对齐源项目「标题＋详解」平铺小点形态，
//      迁移方案 A04 明确排除独立卖点归纳模型调用。
// v21：核验后全局组织卖点＋详解，运行时与展示、脚本输入使用同一份完整卖点。
// v22：模板改写生成并保留封面主副标题，接入三字段校验和定向标题修复。
// v23：普通长图切片复用一次整页缩放结果，避免每张切片重复缩放/编码整页。
const SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION = 26;
const SCRIPT_STUDIO_SCHEDULER_VERSION_KEY = Symbol.for('creative-studio.script-studio-scheduler-version');
const SCRIPT_STUDIO_SCHEDULER_START_KEY = Symbol.for('creative-studio.script-studio-scheduler-start');

async function startCurrentScriptStudioScheduler(): Promise<ScriptStudioSchedulerController> {
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const existing = globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] as ScriptStudioSchedulerController | undefined;
  const existingVersion = globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY];
  if (existing && existingVersion === SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION) {
    return existing;
  }
  if (existing) {
    await existing.stop();
    if (globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] === existing) {
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_KEY];
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY];
    }
  }
  const db = getDb();
  recoverScriptStudioTasks(db);
  const scheduler = startScriptStudioScheduler({
    db,
    workerId: 'script-studio-scheduler',
    executor: {
      async execute(task, signal) {
        const { runDeps } = createRuntimeDeps(getDb(), task, { signal, fallbackOnInvalid: false });
        await executeScriptStudioTask(runDeps);
      },
    },
    intervalMs: 2_000,
    concurrency: 1,
  });
  globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] = scheduler;
  globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY] = SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION;
  return scheduler;
}

export async function ensureScriptStudioSchedulerStarted(): Promise<ScriptStudioSchedulerController> {
  // 安全闸门：在没有明确真机授权前，生产调度器不得自动调用真实供应商。
  // 阶段 0-5 的验收通过直接注入假供应商的 runner 测试完成；部署到真机时
  // 由运行者显式设置 CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1。
  if (process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER !== '1') {
    throw new Error('script-studio scheduler disabled: real provider calls require explicit authorization');
  }
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const existing = globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] as ScriptStudioSchedulerController | undefined;
  if (
    existing
    && globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY] === SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION
  ) {
    return existing;
  }
  const pending = globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] as Promise<ScriptStudioSchedulerController> | undefined;
  if (pending) return pending;
  const startPromise = startCurrentScriptStudioScheduler();
  globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] = startPromise;
  try {
    return await startPromise;
  } finally {
    if (globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] === startPromise) {
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY];
    }
  }
}

export async function startScriptStudioSchedulerAfterReadiness(): Promise<ScriptStudioSchedulerController | null> {
  try {
    const readiness = await getScriptStudioReadiness();
    if (scriptStudioReadinessUnavailable(readiness)) return null;
    recoverScriptStudioTasks(getDb());
    if (process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER !== '1') return null;
    return await ensureScriptStudioSchedulerStarted();
  } catch {
    return null;
  }
}

export { getScriptStudioSchedulerController };
