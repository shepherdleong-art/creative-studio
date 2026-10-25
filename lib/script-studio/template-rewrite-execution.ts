import type Database from 'better-sqlite3';
import type { DirectionSellingPointBrief } from './direction-briefs.ts';
import { ScriptStudioError } from './errors.ts';
import { parseScriptStudioTargetDuration } from './generation-contract.ts';
import type { ScriptGenerator, TemplateRewriteResumeState } from './generator.ts';
import type { LibraryRevisionView } from './libraries.ts';
import type { PlannedScript } from './planner.ts';
import { getTask, mergeStagePayload, taskStoredIdentity } from './tasks.ts';
import { parseFrozenTemplatePlan, TEMPLATE_REWRITE_VERSION, templatePlanFingerprint } from './template-rewrite.ts';
import type { ScriptTitleSummary } from './title-policy.ts';
import type { ScriptStudioScriptContent, SellingPointRecord } from './types.ts';
import { readViralTemplateStyleCache, writeViralTemplateStyleCache } from './viral-templates.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function payload(json: string | undefined): Record<string, unknown> {
  try { return record(JSON.parse(json || '{}')); } catch { return {}; }
}

/**
 * 一次任务的模板执行会话：恢复、缓存和同模板变体顺序都在此收口。
 * 返回的卖点包与正文元数据使用同一筛选白名单，供 runner 的标题修复/最终校验使用。
 * 请求预算仍由注入的 generator 持有，恢复不新建或重置预算；任务生命周期与最终保存留在 runner。
 */
export function createTemplateRewriteExecution(options: {
  db: Database.Database;
  projectId: string;
  taskId: string;
  inputSnapshot: Record<string, unknown>;
  libraryRevision: LibraryRevisionView;
  eligiblePoints: SellingPointRecord[];
  generator: ScriptGenerator;
  /** runner 持有并逐条追加的实时数组；必须在队列执行时读取。 */
  savedScripts: ScriptStudioScriptContent[];
  recentTitles: ScriptTitleSummary[];
  signal?: AbortSignal;
  now?: () => Date;
}) {
  const { db, projectId, taskId, inputSnapshot, libraryRevision, eligiblePoints, generator, signal, now } = options;
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在');
  const templates = parseFrozenTemplatePlan(inputSnapshot.templatePlan);
  const fingerprint = templatePlanFingerprint(templates);
  const snapshotIdentity = taskStoredIdentity({
    ...task, libraryRevisionId: libraryRevision.id, inputSnapshotJson: JSON.stringify(inputSnapshot),
  });
  const identity = `${snapshotIdentity}:${TEMPLATE_REWRITE_VERSION}`;
  const stored = payload(task.stages.find((stage) => stage.stage === 'generate')?.payloadJson);
  // 旧检查点只有模板指纹；任务快照本身不可变，仍可恢复。新检查点另绑定完整快照与提示词版本。
  const canResume = stored.templatePlanFingerprint === fingerprint
    && (stored.templateExecutionIdentity === identity
      || (stored.templateExecutionIdentity === undefined
        && taskStoredIdentity(task) === snapshotIdentity));
  const storedStates = canResume ? record(stored.templateStates) : {};
  const states: Record<number, TemplateRewriteResumeState> = {};
  const providerModel = typeof inputSnapshot.providerModel === 'string' ? inputSnapshot.providerModel : '';
  const targetDurationSec = parseScriptStudioTargetDuration(inputSnapshot.targetDurationSec);
  const eligibleIds = new Set(eligiblePoints.map((point) => point.id));
  const chains = new Map<string, Promise<void>>();
  const variants = new Map<string, string[]>();
  const addVariant = (entryId: string, content: ScriptStudioScriptContent): void => {
    const texts = variants.get(entryId) ?? [];
    texts.push(`标题：${content.title}\n${(content.fullScript || '').slice(0, 500)}`);
    variants.set(entryId, texts);
  };
  for (const content of options.savedScripts) {
    if (content.templateRewrite?.entryId) addVariant(content.templateRewrite.entryId, content);
  }

  const checkedState = (state: TemplateRewriteResumeState): TemplateRewriteResumeState => {
    if (state.whitelistPointIds !== undefined
      && (!Array.isArray(state.whitelistPointIds) || !state.whitelistPointIds.length
        || state.whitelistPointIds.some((id) => !eligibleIds.has(id)))) {
      throw new ScriptStudioError('invalid_input', '模板改写检查点包含无效的卖点白名单');
    }
    return { ...state, ...(state.whitelistPointIds ? { whitelistPointIds: [...state.whitelistPointIds] } : {}) };
  };

  return {
    run(plan: PlannedScript, brief: DirectionSellingPointBrief) {
      const template = plan.templateRewrite;
      if (!template) throw new ScriptStudioError('invalid_input', '缺少爆文模板');
      const queued = chains.get(template.entryId) ?? Promise.resolve();
      const run = queued.then(async () => {
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        if (!generator.runTemplateRewrite) throw new ScriptStudioError('invalid_input', '当前生成器不支持爆文模板改写');
        const state = checkedState(record(storedStates[String(plan.index)]) as TemplateRewriteResumeState);
        // null 是已完成的降级，只有 undefined 才读共享缓存或重新分析。
        if (state.styleAnalysis === undefined && providerModel) {
          const cached = readViralTemplateStyleCache(db, template.contentHash, providerModel, TEMPLATE_REWRITE_VERSION);
          if (cached) {
            try {
              state.styleAnalysis = JSON.parse(cached.analysisJson) as TemplateRewriteResumeState['styleAnalysis'];
              state.styleDegraded = '';
            } catch { /* 损坏缓存按未命中处理，已完成筛选不重跑。 */ }
          }
        }
        states[plan.index] = checkedState(state);
        const persist = (next: TemplateRewriteResumeState): void => {
          const selected = states[plan.index]?.whitelistPointIds;
          if (selected && JSON.stringify(next.whitelistPointIds) !== JSON.stringify(selected)) {
            throw new ScriptStudioError('invalid_input', '模板改写不得改变已冻结的卖点白名单');
          }
          states[plan.index] = checkedState(next);
          mergeStagePayload(db, projectId, taskId, 'generate', {
            templatePlanFingerprint: fingerprint,
            templateExecutionIdentity: identity,
            templateStates: { ...storedStates, ...states },
          }, now);
          if (next.styleAnalysis && providerModel) {
            writeViralTemplateStyleCache(db, {
              contentHash: template.contentHash, model: providerModel, promptVersion: TEMPLATE_REWRITE_VERSION,
              analysisJson: JSON.stringify(next.styleAnalysis),
            }, now);
          }
        };
        const result = await generator.runTemplateRewrite({
          plan, libraryRevision, eligiblePoints, targetDurationSec,
          previousTitles: [...options.savedScripts, ...options.recentTitles],
          siblingVariantTexts: variants.get(template.entryId) ?? [],
          resumeState: state, onStateChange: persist, signal,
        });
        persist(result.state);
        const whitelist = states[plan.index]!.whitelistPointIds;
        if (!whitelist?.length || !result.content.templateRewrite) {
          throw new ScriptStudioError('invalid_input', '模板改写缺少筛选结果');
        }
        // 元数据不能自行扩大筛选白名单；后续 validation 会拒绝任何包外正文引用。
        const content = { ...result.content, templateRewrite: { ...result.content.templateRewrite, whitelistPointIds: [...whitelist] } };
        addVariant(template.entryId, content);
        return {
          content,
          brief: { ...brief, requiredPointIds: [...whitelist], optionalPointIds: [], candidateCount: whitelist.length },
        };
      });
      // 一个变体失败不能毒化同模板后续队列；原 promise 的错误仍交给 runner 记录。
      chains.set(template.entryId, run.then(() => {}, () => {}));
      return run;
    },
  };
}
