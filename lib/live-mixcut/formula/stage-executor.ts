import type { BatchTaskExecutor } from '../executors.ts';
import { BatchDomainError } from '../errors.ts';
import { readFormulaGenerationRequest, type FormulaGenerationRequest } from './generation.ts';
import type { FormulaStage } from './selection-store.ts';
import { recheckSelectionFiles, selectFormulaOutput } from './selection.ts';
import { resolveFormulaReplacementModel } from './replacements.ts';
import type { TextJsonModel } from '../../media-core/adapters/text-json.ts';
import { readFormulaStageOverrides } from './reselection.ts';
import { findReusableFormulaSpeech, queueFormulaSpeech, readFormulaSpeechStage } from './speech-store.ts';
import { resolveFormulaSpeechService } from './speech-provider.ts';
import { analyzeFormulaSourceSpeech, withCleanedSourceSpeech } from './source-speech.ts';
import { parseMaterialFilename } from './parse.ts';
import { recheckFormulaCandidate, verifyFormulaCandidate, type FormulaVerifiedCandidate } from './candidate-media.ts';
import type { FormulaSelection } from './selection.ts';
import { mapFormulaAudio } from './audio-mapping.ts';
import { queueFormulaAudioMapping, readFormulaAudioMappingInput } from './audio-mapping-store.ts';
import { queueFormulaNarration, readFormulaNarrationInput, type FormulaNarrationStageResult } from './narration-store.ts';
import { assertFormulaNarrationAudio, synthesizeFormulaNarration } from './narration.ts';
import { queueFormulaTimeline, readFormulaTimelineInput } from './timeline-store.ts';
import { buildFormulaTimeline } from './timeline.ts';
import { materializeFormulaOutput } from './output-store.ts';
import { checkBatchFormulaExecution } from '../batch-renderer.ts';
import { formulaExecutionContentHash, formulaExecutionInputKey, type FormulaExecutionResult } from './execution-store.ts';
import { resolveFullRenderContract } from '../cover-contract.ts';
import { createBatchTask } from '../tasks.ts';
import { buildCoverRenderTaskRequestKey } from '../render-task-key.ts';
import { readFrozenFormulaManualAudio } from './manual-audio-mapping.ts';

/** 模型是外部服务边界；生产与隔离验收均使用同一个任务执行和提交流程。 */
export function createFormulaStageExecutor(resolveModel: (request: FormulaGenerationRequest, projectId: string,
  purpose?: 'replacement' | 'audio_mapping') => Promise<TextJsonModel | null>
  = resolveFormulaReplacementModel): BatchTaskExecutor {
  return {
    workTypes: ['formula_stage'],
    async execute({ db, claim, signal, reportProgress }) {
      if (!claim.task.batchId || claim.task.targetKind !== 'formula_stage') throw new BatchDomainError('invalid_input', '公式任务目标无效');
      const stage = db.prepare('SELECT * FROM live_mixcut_formula_execution_stages WHERE id=?').get(claim.task.targetId) as
        (Omit<FormulaStage, 'kind'> & { kind: 'select' | 'source_speech' | 'audio_mapping' | 'narration' | 'timeline' | 'execution'; selectionStageId: string }) | undefined;
      if (!stage) throw new BatchDomainError('invalid_input', '尚不支持此公式制作阶段');
      const request = readFormulaGenerationRequest(db, claim.task.projectId, claim.task.batchId, stage.requestId);
      const output = request.outputs.find(item => item.planId === stage.planId);
      if (!output) throw new BatchDomainError('conflict', '公式阶段与输出身份不一致');
      if (stage.kind === 'execution') {
        const check = db.prepare('SELECT outputVersionId,inputKey FROM live_mixcut_formula_execution_checks WHERE id=?')
          .get(stage.id) as { outputVersionId: string; inputKey: string };
        const current = () => {
          const row = db.prepare(`SELECT o.arrangementJson FROM live_mixcut_output_versions o JOIN live_mixcut_output_plans p ON p.currentVersionId=o.id
            WHERE o.id=? AND p.id=? AND p.batchVersionId=?`).get(check.outputVersionId, stage.planId, request.batchVersionId) as { arrangementJson: string } | undefined;
          if (!row) throw new BatchDomainError('conflict', '执行检查已被新的成片版本替代');
          const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
          if (formulaExecutionInputKey(db, check.outputVersionId, arrangement) !== check.inputKey) throw new BatchDomainError('conflict', '成片已修改，等待新的执行检查');
          return arrangement;
        };
        current();
        reportProgress({ phase: 'formula_execution', description: '检查实际画面、声音、字幕和包装', percent: null });
        const verified = await checkBatchFormulaExecution({ db, projectId: claim.task.projectId, batchId: claim.task.batchId,
          batchVersionId: request.batchVersionId, planId: stage.planId, outputVersionId: check.outputVersionId, signal });
        const contentContractHash = formulaExecutionContentHash(verified.contract);
        return { commit() {
          const arrangement = current();
          verified.recheck();
          if (contentContractHash !== formulaExecutionContentHash(resolveFullRenderContract(db, check.outputVersionId))) {
            throw new BatchDomainError('conflict', '检查期间制作输入已改变');
          }
          const result: FormulaExecutionResult = { version: 1, status: 'ready', executionReady: true,
            outputVersionId: check.outputVersionId, checkedEditRevision: verified.contract.editRevision, contentContractHash,
            audioMode: verified.audioMode, contract: verified.contract, checkedAt: new Date().toISOString() };
          db.prepare('INSERT INTO live_mixcut_formula_execution_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
            .run(stage.id, JSON.stringify(result), result.checkedAt);
          arrangement.productionReady = true;
          arrangement.formulaExecution = { stageId: stage.id, contentContractHash };
          arrangement.blockers = (Array.isArray(arrangement.blockers) ? arrangement.blockers : []).filter(value => value !== 'formula_execution_pending');
          db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(arrangement), check.outputVersionId);
          createBatchTask(db, claim.task.projectId, { batchId: claim.task.batchId!, workType: 'render', targetKind: 'output_version_cover',
            targetId: check.outputVersionId, requestKey: buildCoverRenderTaskRequestKey(check.outputVersionId, verified.contract.coverContractHash) });
          return { resultJson: result, progress: { phase: 'formula_execution_done', percent: 1, description: '制作检查通过，正在准备审片封面' } };
        } };
      }
      if (stage.kind === 'timeline') {
        const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_timeline_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
        if (existing) return { commit() {
          materializeFormulaOutput(db, claim.task.projectId, claim.task.batchId!, stage.id, request);
          return { resultJson: JSON.parse(existing.resultJson) };
        } };
        const { input, selection } = readFormulaTimelineInput(db, stage.id, request, stage.planId);
        reportProgress({ phase: 'formula_timeline', description: '按实际声音安排画面与字幕时间', percent: null });
        const verified: FormulaVerifiedCandidate[] = [];
        for (const slot of selection.slots) {
          if (verified.some(item => item.assetId === slot.assetId)) continue;
          const candidate = slot.candidate!;
          const actual = await verifyFormulaCandidate(db, claim.task.projectId, candidate.assetId, candidate.contentFingerprint,
            [{ id: candidate.sourceId, location: candidate.location }], signal);
          if (!actual) throw new BatchDomainError('conflict', '排片所需原片无法核验，请恢复同一内容后重试');
          verified.push(actual);
        }
        const verifyNarrations = () => {
          for (const item of input.narration?.result.items ?? []) assertFormulaNarrationAudio(claim.task.projectId, item.text, item.audio);
        };
        verifyNarrations();
        const result = buildFormulaTimeline(input);
        if (result.status === 'waiting_audio') throw new BatchDomainError('conflict', '排片所需声音尚未齐全');
        signal.throwIfAborted();
        return { commit() {
          for (const candidate of verified) recheckFormulaCandidate(db, claim.task.projectId, candidate);
          verifyNarrations();
          db.prepare('INSERT INTO live_mixcut_formula_timeline_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
            .run(stage.id, JSON.stringify(result), new Date().toISOString());
          materializeFormulaOutput(db, claim.task.projectId, claim.task.batchId!, stage.id, request);
          return { resultJson: result, progress: { phase: 'formula_timeline_done', percent: 1,
            description: result.status === 'planned' ? '画面、声音与字幕已保存，正在检查制作条件' : '当前素材与声音无法满足时长要求，请查看原因' } };
        } };
      }
      if (stage.kind === 'narration') {
        const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_narration_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
        if (existing) return { commit() {
          queueFormulaTimeline(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: JSON.parse(existing.resultJson) };
        } };
        const input = readFormulaNarrationInput(db, stage.id, request, stage.planId);
        const items: FormulaNarrationStageResult['items'] = [];
        for (const narration of input.narrations) {
          reportProgress({ phase: 'formula_narration', description: input.externalNarration ? '核验已确认的外部配音和字幕' : '生成剩余文案的声音并对齐字幕', completed: items.length,
            total: input.narrations.length, percent: items.length / input.narrations.length });
          const result = input.externalNarration?.audio ? { status: 'ready' as const, audio: input.externalNarration.audio }
            : await synthesizeFormulaNarration(db, claim.task.projectId, { text: narration.text, service: input.service }, signal);
          if (result.status !== 'ready') throw new BatchDomainError('conflict', result.message);
          items.push({ ...narration, audio: result.audio });
        }
        signal.throwIfAborted();
        const result: FormulaNarrationStageResult = { status: 'ready', executionReady: false, algorithmVersion: 'formula-narration-stage/1', items };
        return { commit() {
          for (const item of items) assertFormulaNarrationAudio(claim.task.projectId, item.text, item.audio);
          db.prepare('INSERT INTO live_mixcut_formula_narration_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
            .run(stage.id, JSON.stringify(result), new Date().toISOString());
          queueFormulaTimeline(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: result, progress: { phase: 'formula_narration_done', percent: 1,
            description: '配音及字幕时间已保存，等待按实际声音安排画面' } };
        } };
      }
      if (stage.kind === 'audio_mapping') {
        const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_audio_mapping_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
        if (existing) return { commit() {
          queueFormulaNarration(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          queueFormulaTimeline(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: JSON.parse(existing.resultJson) };
        } };
        const { input, selection } = readFormulaAudioMappingInput(db, stage.id, request, stage.planId);
        reportProgress({ phase: 'formula_audio_mapping', description: '核对原声已说内容，分配剩余配音文案', percent: null });
        const manual = readFrozenFormulaManualAudio(db, stage.selectionStageId, input);
        const external = request.input.externalNarrations?.find(item => item.scriptKey === request.outputs.find(output => output.planId === stage.planId)?.scriptKey);
        const imported = external ? { confirmed: true, blocks: [{ kind: 'tts', text: external.text, slotIds: input.slots.map(slot => slot.slotId) }] } : undefined;
        const result = await mapFormulaAudio({ ...input, ...(manual ? { manual: manual.manual } : imported ? { manual: imported } : {}) },
          () => resolveModel(request, claim.task.projectId, 'audio_mapping'), signal);
        if (manual && result.status === 'mapped') result.manualVerification = manual.verification;
        else if (external && result.status === 'mapped') result.manualVerification = { revisionId: external.id, confirmedAt: external.createdAt };
        if (result.status === 'waiting_speech') throw new BatchDomainError('conflict', '声音映射所需原声记录尚未齐全');
        const verified: FormulaVerifiedCandidate[] = [];
        for (const slot of selection.slots) {
          if (verified.some(item => item.assetId === slot.assetId)) continue;
          const candidate = slot.candidate!;
          const actual = await verifyFormulaCandidate(db, claim.task.projectId, candidate.assetId, candidate.contentFingerprint,
            [{ id: candidate.sourceId, location: candidate.location }], signal);
          if (!actual) throw new BatchDomainError('conflict', '声音编排后原片无法核验，请恢复同一内容后重试');
          verified.push(actual);
        }
        signal.throwIfAborted();
        return { commit() {
          for (const candidate of verified) recheckFormulaCandidate(db, claim.task.projectId, candidate);
          db.prepare('INSERT INTO live_mixcut_formula_audio_mapping_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
            .run(stage.id, JSON.stringify(result), new Date().toISOString());
          queueFormulaNarration(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          queueFormulaTimeline(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: result, progress: { phase: 'formula_audio_mapping_done', percent: 1,
            description: result.status === 'mapped' ? '已分清原声与剩余文案，等待实际配音和时间编排' : '原声与文案存在需要处理的对应问题' } };
        } };
      }
      if (stage.kind === 'source_speech') {
        const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_speech_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
        if (existing) return { commit() {
          queueFormulaAudioMapping(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: JSON.parse(existing.resultJson) };
        } };
        const source = readFormulaSpeechStage(db, stage.id);
        const row = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?').get(source.selectionStageId) as { resultJson: string } | undefined;
        const selection: FormulaSelection | null = row ? JSON.parse(row.resultJson) : null;
        const candidate = selection?.slots.find(slot => slot.assetId === source.assetId)?.candidate;
        if (selection?.status !== 'selected' || !candidate || candidate.contentFingerprint !== source.contentFingerprint) {
          throw new BatchDomainError('conflict', '原声任务与已保存的选片不一致');
        }
        reportProgress({ phase: 'formula_source_speech', description: '核验原片并识别实际台词', percent: null });
        // 清洗要用台词判断「这句本来就以口令开头/结尾」，台词来自素材文件名。
        const plannedLine = (() => {
          const binding = request.input.materialIndex.bindings.find(item => item.assetId === source.assetId
            && item.contentFingerprint === source.contentFingerprint);
          return binding ? parseMaterialFilename(binding.sourceName).voLine : null;
        })();
        let result = findReusableFormulaSpeech(db, claim.task.projectId, source) ?? await analyzeFormulaSourceSpeech(db, claim.task.projectId, { assetId: source.assetId,
          contentFingerprint: source.contentFingerprint, sources: [{ id: candidate.sourceId, location: candidate.location }], manualSpeech: source.manualSpeech, plannedLine },
        () => resolveFormulaSpeechService(source.service), signal);
        // 旧批次的识别结果在这里补做清洗，不再调用识别服务。
        result = withCleanedSourceSpeech(result, plannedLine);
        signal.throwIfAborted();
        if (result.status === 'needs_attention' && ['source_unavailable', 'transcription_failed'].includes(result.reason)) {
          throw new BatchDomainError('conflict', result.message);
        }
        // 内容恢复为同一指纹可继续；发布时用本次核验的文件身份，不能沿用旧选片时的 mtime。
        const verified = await verifyFormulaCandidate(db, claim.task.projectId, source.assetId, source.contentFingerprint,
          [{ id: candidate.sourceId, location: candidate.location }], signal);
        if (!verified) throw new BatchDomainError('conflict', '原声检查后原片无法核验，请恢复同一内容后重试');
        if (result.status !== 'needs_attention') result = { ...result, sourceId: verified.sourceId };
        signal.throwIfAborted();
        return { commit() {
          recheckFormulaCandidate(db, claim.task.projectId, verified);
          db.prepare('INSERT INTO live_mixcut_formula_speech_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
            .run(stage.id, JSON.stringify(result), new Date().toISOString());
          queueFormulaAudioMapping(db, claim.task.projectId, claim.task.batchId!, stage.selectionStageId, request);
          return { resultJson: result, progress: { phase: 'formula_source_speech_done', percent: 1,
            description: result.status === 'transcribed' ? result.manualVerification ? '采用人工核对的台词和时间，等待编排与审片' : '原声台词已识别，等待逐条声音编排与审片'
              : result.status === 'no_speech' ? result.manualVerification ? '人工确认没有人声，等待编排其余声音' : '识别服务未检测到人声，等待编排其余声音'
                : result.status === 'no_audio_stream' ? '原片没有音轨，等待配置这条成片的配音' : result.message } };
        } };
      }
      const existing = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?').get(stage.id) as { resultJson: string } | undefined;
      if (existing) return { commit() {
        const result = JSON.parse(existing.resultJson) as FormulaSelection;
        queueFormulaSpeech(db, claim.task.projectId, claim.task.batchId!, { ...stage, kind: 'select' }, request, result);
        queueFormulaAudioMapping(db, claim.task.projectId, claim.task.batchId!, stage.id, request);
        return { resultJson: result };
      } };
    const revised = readFormulaStageOverrides(db, stage.id);
    if (stage.revision > 1 && !revised) throw new BatchDomainError('conflict', '这次重选的输入记录缺失，不能沿用旧输入');
    const result = await selectFormulaOutput(db, claim.task.projectId, revised ? { ...request, seed: revised.seed } : request, output, signal, (completed, total) => {
      reportProgress({ phase: 'formula_select', description: '按公式编号核验并选择素材', completed, total, percent: completed / total });
    }, () => resolveModel(request, claim.task.projectId), revised?.overrides);
    signal.throwIfAborted();
    return { commit() {
      recheckSelectionFiles(db, claim.task.projectId, result);
      db.prepare('INSERT INTO live_mixcut_formula_selection_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
        .run(stage.id, JSON.stringify(result), new Date().toISOString());
      queueFormulaSpeech(db, claim.task.projectId, claim.task.batchId!, { ...stage, kind: 'select' }, request, result);
      queueFormulaAudioMapping(db, claim.task.projectId, claim.task.batchId!, stage.id, request);
      return { resultJson: result, progress: { phase: 'formula_select_done', percent: 1,
        description: result.status === 'selected' ? (result.slots.some(slot => slot.replacement || slot.manualReplacement)
          ? `已选定文件，替换 ${result.slots.filter(slot => slot.replacement || slot.manualReplacement).length} 处待审；等待核验声音和区间`
          : result.slots.every(slot => slot.rangeStatus === 'confirmed')
          ? '已选定文件与人工确认区间，等待核验声音和最终裁切' : '已选定文件，等待核验声音与可用区间')
          : '已检查公式，有缺失或不可用素材需要处理' } };
    } };
  },
};
}

export const formulaStageExecutor = createFormulaStageExecutor();
