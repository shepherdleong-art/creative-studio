'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';
import ScriptSellingPointInput from './ScriptSellingPointInput';
import ScriptStrategyConfig from './ScriptStrategyConfig';
import ScriptResultView from './ScriptResultView';
import {
  canNavigateToScriptStep,
  getScriptStepStatus,
  type ScriptStep,
} from '@/lib/script-workflow';
import {
  getDefaultSelectedSellingPointKeys,
  resolveSelectedSellingPoints,
} from '@/lib/script-strategy';
import type { ScriptGenerationProgress } from '@/lib/script-generation-v3';
import type {
  AnalysisResult,
  ProviderMeta,
  ScriptOutput,
  ScriptOutputV3,
  ScriptStrategyAnalysisV3,
  StoredScriptOutput,
} from '@/lib/script-providers';

// ── Types ──

interface ScriptDraft {
  id: string;
  provider: string;
  model: string;
  inputSnapshot: string;
  outputJson: string;
  createdAt: string;
}

interface ShotSetOption {
  id: string;
  name: string;
  shotCount: number;
  status: string;
}

interface ShotWithImage {
  shotId: string;
  shotIndex: number;
  sourceImageUrl?: string;
  generatedImageUrl?: string;
  sourceFilename: string;
}

interface Props {
  projectId: string;
}

type Step = ScriptStep;

const STEP_LABELS: Record<Step, string> = {
  1: '卖点',
  2: '策略',
  3: '脚本',
};

const INITIAL_GENERATION_PROGRESS: ScriptGenerationProgress = {
  phase: 'preparing',
  percent: 2,
  message: '正在保存脚本设置',
};

/** GET /api/projects/[id]/script-generation 返回的任务快照（服务端管理器 §A3）。 */
type ScriptGenerationState = 'running' | 'succeeded' | 'failed' | 'cancelled';

interface ScriptGenerationSnapshot {
  generationId: string;
  projectId: string;
  state: ScriptGenerationState;
  progress: ScriptGenerationProgress;
  draftId: string | null;
  error: { code: string; message: string } | null;
  cancellationReason: 'user' | 'shutdown' | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 旧版（v1）草稿是 {shots, duration}，没有 segments/version，直接 render 会在 .segments.map 上炸整页。 */
function isValidScriptOutput(value: unknown): value is ScriptOutput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; segments?: unknown; droppedShots?: unknown };
  return candidate.version === 2 && Array.isArray(candidate.segments) && Array.isArray(candidate.droppedShots);
}

function isV3ScriptOutput(value: unknown): value is ScriptOutputV3 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; segments?: unknown; fullSubtitle?: unknown };
  return candidate.version === 3 && Array.isArray(candidate.segments) && typeof candidate.fullSubtitle === 'string';
}

function isSupportedScriptOutput(value: unknown): value is StoredScriptOutput {
  return isValidScriptOutput(value) || isV3ScriptOutput(value);
}

function isV3Analysis(value: AnalysisResult | ScriptStrategyAnalysisV3): value is ScriptStrategyAnalysisV3 {
  return 'version' in value && value.version === 3;
}

function readDraftSnapshot(draft: ScriptDraft): { shotSetId?: string; shotSetName?: string } {
  try {
    return JSON.parse(draft.inputSnapshot || '{}') as { shotSetId?: string; shotSetName?: string };
  } catch {
    return {};
  }
}

function readDraftShotSetId(draft: ScriptDraft): string {
  const snapshot = readDraftSnapshot(draft);
  if (snapshot.shotSetId) return snapshot.shotSetId;

  try {
    const output = JSON.parse(draft.outputJson || '{}') as { shotSetId?: string };
    return output.shotSetId || '';
  } catch {
    return '';
  }
}

function buildDraftLabels(drafts: ScriptDraft[], shotSets: ShotSetOption[]): Map<string, string> {
  const shotSetNames = new Map(shotSets.map((set) => [set.id, set.name]));
  const draftNumbers = new Map<string, number>();
  const counters = new Map<string, number>();

  [...drafts]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .forEach((draft) => {
      const shotSetKey = readDraftShotSetId(draft) || '__missing_shot_set__';
      const nextNumber = (counters.get(shotSetKey) || 0) + 1;
      counters.set(shotSetKey, nextNumber);
      draftNumbers.set(draft.id, nextNumber);
    });

  return new Map(
    drafts.map((draft) => {
      const snapshot = readDraftSnapshot(draft);
      const shotSetId = snapshot.shotSetId || readDraftShotSetId(draft);
      const shotSetName = (shotSetId ? shotSetNames.get(shotSetId) : '') || snapshot.shotSetName || '未关联分镜组';
      const scriptNumber = draftNumbers.get(draft.id) || 1;
      return [draft.id, `${shotSetName} · 脚本${scriptNumber}`];
    })
  );
}
// ── Component ──

export default function ScriptPanel({ projectId }: Props) {
  // ── Core state ──
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [cancellingGeneration, setCancellingGeneration] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<ScriptGenerationProgress>(INITIAL_GENERATION_PROGRESS);

  // Brief (from project)
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('种草');
  const [platform, setPlatform] = useState('通用');
  const [sellingPoints, setSellingPoints] = useState('');

  // Analysis
  const [analysis, setAnalysis] = useState<AnalysisResult | ScriptStrategyAnalysisV3 | null>(null);
  const [analysisProviderId, setAnalysisProviderId] = useState('gemini');
  const [analyzing, setAnalyzing] = useState(false);

  // Strategy
  const [selectedSellingPointKeys, setSelectedSellingPointKeys] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState('scene_seeding');
  const [templateName, setTemplateName] = useState('场景种草');
  const [targetDurationSec, setTargetDurationSec] = useState(20);
  const [generateProviderId, setGenerateProviderId] = useState('gemini');

  // ShotSet selection
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [selectedShotSetId, setSelectedShotSetId] = useState('');

  // Result
  const [script, setScript] = useState<StoredScriptOutput | null>(null);
  const [drafts, setDrafts] = useState<ScriptDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [shotImages, setShotImages] = useState<ShotWithImage[]>([]);
  const [legacyDraftNotice, setLegacyDraftNotice] = useState(false);

  // Models
  const [providers, setProviders] = useState<ProviderMeta[]>([]);

  // Refs
  const initialLoadDone = useRef(false);
  const generationIdRef = useRef<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载只取消状态查询轮询，绝不取消服务端生成任务
  useEffect(() => () => {
    pollAbortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const hydrateStrategyFromDraft = useCallback((
    draft: ScriptDraft,
    options: { restoreSellingPoints?: boolean } = {},
  ) => {
    try {
      const snapshot = JSON.parse(draft.inputSnapshot || '{}') as {
        selectedSellingPoints?: Array<{ sellingPointId?: string; title?: string }>;
        templateId?: string;
        templateName?: string;
        targetDurationSec?: number;
        shotSetId?: string;
        providerId?: string;
        tone?: string;
        platform?: string;
      };

      const selectionKeys = Array.isArray(snapshot.selectedSellingPoints)
        ? snapshot.selectedSellingPoints
            .map((point) => point.sellingPointId?.trim() || point.title?.trim() || '')
            .filter(Boolean)
        : [];

      if (options.restoreSellingPoints !== false) setSelectedSellingPointKeys(selectionKeys);
      if (snapshot.templateId) setTemplateId(snapshot.templateId);
      if (snapshot.templateName) setTemplateName(snapshot.templateName);
      if (snapshot.targetDurationSec) setTargetDurationSec(snapshot.targetDurationSec);
      if (snapshot.shotSetId) setSelectedShotSetId(snapshot.shotSetId);
      if (snapshot.providerId) setGenerateProviderId(snapshot.providerId);
      if (snapshot.tone) setTone(snapshot.tone);
      if (snapshot.platform) setPlatform(snapshot.platform);
    } catch { /* ignore corrupt draft snapshots */ }
  }, []);

  // ── Load shot images for result view (must be declared before loadAll) ──
  const loadShotImages = useCallback(async (shotSetId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`);
      const sets = await res.json() as Array<{ id: string }>;
      const set = sets.find((s) => s.id === shotSetId);
      if (!set) return;

      const detailRes = await fetch(`/api/shot-sets/${shotSetId}`);
      const detail = await detailRes.json() as {
        shots?: Array<{
          id: string;
          indexNum: number;
          sourceImageUrl?: string;
          generatedImageUrl?: string;
          sourceFilename?: string;
        }>;
      };

      if (detail.shots) {
        setShotImages(
          detail.shots.map((s) => ({
            shotId: s.id,
            shotIndex: s.indexNum,
            sourceImageUrl: s.sourceImageUrl,
            generatedImageUrl: s.generatedImageUrl,
            sourceFilename: s.sourceFilename || '',
          }))
        );
      }
    } catch { /* ignore */ }
  }, [projectId]);

  // ── Terminal state handling（轮询/取消共用）──
  const applyTerminalSnapshot = useCallback(async (snapshot: ScriptGenerationSnapshot) => {
    if (snapshot.state === 'succeeded') {
      // 成功后重新加载草稿，按服务端返回的 draftId 选中结果
      const listRes = await fetch(`/api/projects/${projectId}/script`);
      const listData = await listRes.json().catch(() => ({ drafts: [] }));
      if (listData.drafts?.length > 0) {
        const freshDrafts = listData.drafts as ScriptDraft[];
        setDrafts(freshDrafts);
        const produced = freshDrafts.find((d) => d.id === snapshot.draftId) ?? freshDrafts[0];
        setSelectedDraftId(produced.id);
        hydrateStrategyFromDraft(produced, { restoreSellingPoints: false });
        try {
          const parsed = JSON.parse(produced.outputJson) as unknown;
          if (isSupportedScriptOutput(parsed)) {
            setLegacyDraftNotice(false);
            setScript(parsed);
            setStep(3);
            if (parsed.version === 2 && parsed.shotSetId) {
              void loadShotImages(parsed.shotSetId);
            }
          }
        } catch { /* ignore corrupt draft */ }
      }
    } else if (snapshot.state === 'failed') {
      alert('生成失败: ' + (snapshot.error?.message || '未知错误'));
    }
    // cancelled：静默恢复按钮状态，不弹失败提示
    generationIdRef.current = null;
    setGenerating(false);
    setCancellingGeneration(false);
  }, [projectId, hydrateStrategyFromDraft, loadShotImages]);

  // ── 轮询任务状态（组件自己的查询 AbortController；卸载只取消查询，不取消服务端任务）──
  const pollGeneration = useCallback((generationId: string) => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/script-generation`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        const snapshot = data.generation as ScriptGenerationSnapshot | null;
        if (controller.signal.aborted) return;
        if (!snapshot || snapshot.generationId !== generationId) {
          // 任务已过期或进程重启：恢复按钮状态
          generationIdRef.current = null;
          setGenerating(false);
          setCancellingGeneration(false);
          return;
        }
        if (snapshot.state === 'running') {
          setGenerationProgress(snapshot.progress);
          pollTimerRef.current = setTimeout(() => { void poll(); }, 1000);
          return;
        }
        await applyTerminalSnapshot(snapshot);
      } catch {
        if (controller.signal.aborted) return;
        // 查询失败（网络抖动等）：继续轮询，不影响服务端任务
        pollTimerRef.current = setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
  }, [projectId, applyTerminalSnapshot]);

  // ── Initial load ──
  useEffect(() => {
    let active = true;

    const run = async () => {
      try {
        const [projRes, draftRes, modelRes, shotSetRes, generationRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`),
          fetch(`/api/projects/${projectId}/script`),
          fetch(`/api/projects/${projectId}/script?action=models`),
          fetch(`/api/projects/${projectId}/shot-sets`),
          fetch(`/api/projects/${projectId}/script-generation`, { cache: 'no-store' }),
        ]);

        const projData = await projRes.json().catch(() => ({}));
        const draftData = await draftRes.json().catch(() => ({ drafts: [], analysis: null }));
        const modelData = await modelRes.json().catch(() => ({ providers: [] }));
        const shotSetData = await shotSetRes.json().catch(() => []);
        const generationData = await generationRes.json().catch(() => ({ generation: null }));

        if (!active) return;

        // 恢复进行中的生成任务（步骤切换/刷新后回到本面板）
        const snapshot = generationData.generation as ScriptGenerationSnapshot | null;
        if (snapshot?.state === 'running') {
          generationIdRef.current = snapshot.generationId;
          setGenerationProgress(snapshot.progress);
          setCancellingGeneration(false);
          setGenerating(true);
          pollGeneration(snapshot.generationId);
        }

        // Brief
        setAudience(projData.targetAudience || '');
        setTone(projData.scriptTone || '种草');
        setPlatform(projData.scriptPlatform || '通用');
        try {
          const sp = JSON.parse(projData.sellingPointsJson || '[]') as Array<{ title: string }>;
          setSellingPoints(sp.map((s) => s.title).join('\n'));
        } catch { /* ignore */ }

        // Analysis
        if (draftData.analysis) {
          const loadedAnalysis = draftData.analysis as AnalysisResult | ScriptStrategyAnalysisV3;
          setAnalysis(loadedAnalysis);
          setSelectedSellingPointKeys((current) => {
            if (current.length > 0) return current;
            return getDefaultSelectedSellingPointKeys(loadedAnalysis);
          });
          if (isV3Analysis(loadedAnalysis)) {
            setTemplateId(loadedAnalysis.recommendedTemplate.id);
            setTemplateName(loadedAnalysis.recommendedTemplate.name);
          }
          setStep(2);
        }

        // Drafts
        if (draftData.drafts?.length > 0) {
          setDrafts(draftData.drafts);
          if (!initialLoadDone.current) {
            initialLoadDone.current = true;
            const first = draftData.drafts[0] as ScriptDraft;
            setSelectedDraftId(first.id);
            hydrateStrategyFromDraft(first, { restoreSellingPoints: false });
            try {
              const parsed = JSON.parse(first.outputJson) as unknown;
              if (isSupportedScriptOutput(parsed)) {
                setScript(parsed);
                setStep(3);
                if (parsed.version === 2 && parsed.shotSetId) {
                  void loadShotImages(parsed.shotSetId);
                }
              } else {
                setLegacyDraftNotice(true);
              }
            } catch { /* ignore */ }
          }
        }

        // Models
        if (modelData.providers?.length > 0) {
          setProviders(modelData.providers);
        }

        // ShotSets
        const sets = Array.isArray(shotSetData) ? shotSetData as ShotSetOption[] : [];
        setShotSets(sets);
        if (sets.length === 1) {
          setSelectedShotSetId((current) => current || sets[0].id);
        }

        // P1: Mark loading as done after all data is loaded
        setLoading(false);

        // P2: Analysis may use text-only models, but script generation now requires vision.
        if (modelData.providers?.length > 0) {
          const configured = (modelData.providers as ProviderMeta[]).find((p) => p.configured);
          const vision = (modelData.providers as ProviderMeta[]).find((p) => p.configured && p.supportsVision);
          if (configured) setAnalysisProviderId(configured.id);
          if (vision) setGenerateProviderId(vision.id);
        }
      } catch {
        if (active) setLoading(false);
      }
    };

    run();
    return () => { active = false; };
  }, [projectId, hydrateStrategyFromDraft, loadShotImages, pollGeneration]);

  // ── Save brief ──
  const saveBrief = useCallback(async () => {
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAudience: audience,
        scriptTone: tone,
        scriptPlatform: platform,
        sellingPointsJson: JSON.stringify(
          sellingPoints
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((s) => ({ title: s.trim(), priority: 0 }))
        ),
      }),
    });
  }, [projectId, audience, tone, platform, sellingPoints]);

  // ── Handle analyze ──
  const handleAnalyze = useCallback(async () => {
    if (!sellingPoints.trim()) {
      alert('请至少输入一条卖点');
      return;
    }
    if (!audience.trim()) {
      alert('请先填写目标人群，再进行策略分析');
      return;
    }
    setAnalyzing(true);
    try {
      await saveBrief();
      const res = await fetch(`/api/projects/${projectId}/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'analyze',
          sellingPoints: sellingPoints.trim().split('\n').filter(Boolean),
          targetAudience: audience,
          platform,
          providerId: analysisProviderId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const analyzed = data.analysis as AnalysisResult | ScriptStrategyAnalysisV3;
        setAnalysis(analyzed);
        setSelectedSellingPointKeys(getDefaultSelectedSellingPointKeys(analyzed));
        if (isV3Analysis(analyzed)) {
          setTemplateId(analyzed.recommendedTemplate.id);
          setTemplateName(analyzed.recommendedTemplate.name);
        }
        setStep(2);
      } else {
        alert('分析失败: ' + (data.message || data.error || '未知错误'));
      }
    } catch (err) {
      alert('分析失败: ' + String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [projectId, sellingPoints, audience, platform, analysisProviderId, saveBrief]);

  // ── Handle generate ──
  const handleCancelGeneration = useCallback(() => {
    const generationId = generationIdRef.current;
    if (!generationId || cancellingGeneration) return;
    setCancellingGeneration(true);
    setGenerationProgress((current) => ({ ...current, message: '正在取消生成…' }));
    // 显式取消走 DELETE；轮询会跟进到 cancelled 终态，请求失败时由轮询兜底
    void fetch(`/api/projects/${projectId}/script-generation?generationId=${encodeURIComponent(generationId)}`, {
      method: 'DELETE',
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        const snapshot = data.generation as ScriptGenerationSnapshot | null;
        if (snapshot && snapshot.state !== 'running') await applyTerminalSnapshot(snapshot);
      })
      .catch(() => undefined);
  }, [cancellingGeneration, projectId, applyTerminalSnapshot]);

  const handleGenerate = useCallback(async () => {
    if (!selectedShotSetId) {
      alert('请选择一个分镜组');
      return;
    }
    if (selectedSellingPointKeys.length === 0) {
      alert('请至少选择一个卖点');
      return;
    }
    const spWithData = resolveSelectedSellingPoints(analysis, selectedSellingPointKeys);
    if (spWithData.length !== selectedSellingPointKeys.length) {
      alert('选中的卖点与当前策略分析不一致，请重新分析后再生成');
      return;
    }

    const generationId = crypto.randomUUID();
    generationIdRef.current = generationId;
    setGenerationProgress(INITIAL_GENERATION_PROGRESS);
    setCancellingGeneration(false);
    setGenerating(true);
    try {
      await saveBrief();
      const res = await fetch(`/api/projects/${projectId}/script-generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationId,
          shotSetId: selectedShotSetId,
          selectedSellingPoints: spWithData,
          templateId,
          templateName,
          targetDurationSec,
          providerId: generateProviderId,
          tone,
          platform,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        // 以服务端返回的权威任务 ID 为准开始轮询（同项目已有活动任务时复用）
        const authoritativeId = (data.generation?.generationId as string) || generationId;
        generationIdRef.current = authoritativeId;
        pollGeneration(authoritativeId);
      } else {
        alert('生成失败: ' + String(data.message || data.error || `HTTP ${res.status}`));
        generationIdRef.current = null;
        setGenerating(false);
      }
    } catch (err) {
      alert('生成失败: ' + String(err));
      generationIdRef.current = null;
      setGenerating(false);
    }
  }, [
    projectId, selectedShotSetId, selectedSellingPointKeys, analysis,
    templateId, templateName, targetDurationSec, generateProviderId,
    tone, platform, saveBrief, pollGeneration,
  ]);

  // ── Handle selecting a draft ──
  const handleSelectDraft = useCallback((draftId: string) => {
    const draft = drafts.find((d) => d.id === draftId);
    if (draft) {
      setSelectedDraftId(draftId);
      hydrateStrategyFromDraft(draft);
      try {
        const parsed = JSON.parse(draft.outputJson) as unknown;
        if (isSupportedScriptOutput(parsed)) {
          setLegacyDraftNotice(false);
          setScript(parsed);
          setStep(3);
          if (parsed.version === 2 && parsed.shotSetId) {
            void loadShotImages(parsed.shotSetId);
          }
        } else {
          setScript(null);
          setLegacyDraftNotice(true);
        }
      } catch { /* ignore */ }
    }
  }, [drafts, hydrateStrategyFromDraft, loadShotImages]);

  // ── Step navigation ──
  const handleStepSelect = useCallback((targetStep: Step) => {
    if (!canNavigateToScriptStep(targetStep, { hasAnalysis: Boolean(analysis), hasScript: Boolean(script) })) return;
    setStep(targetStep);
  }, [analysis, script]);

  const handleBackToBrief = useCallback(() => {
    setStep(1);
    setAnalysis(null);
    setScript(null);
    setSelectedDraftId(null);
    setShotImages([]);
    setLegacyDraftNotice(false);
  }, []);

  // ── Derive display image URL ──
  const getShotImageUrl = useCallback((shotId: string): string | undefined => {
    const img = shotImages.find((s) => s.shotId === shotId);
    return img?.generatedImageUrl || img?.sourceImageUrl;
  }, [shotImages]);

  // ── Render ──
  const stepStatus = getScriptStepStatus({
    step,
    hasAnalysis: Boolean(analysis),
    hasScript: Boolean(script),
  });
  const draftLabels = useMemo(() => buildDraftLabels(drafts, shotSets), [drafts, shotSets]);

  if (loading) {
    return (
      <div className="card p-4">
        <div className="py-8 text-center text-ink-tertiary">
          <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          加载中…
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
        <div className="flex items-center gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="file-text" size={16} />
            脚本生成
          </h2>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5 text-xs" aria-label="脚本生成步骤">
            {([1, 2, 3] as Step[]).map((item, index) => {
              const status = stepStatus[item];
              const canSelect = canNavigateToScriptStep(item, {
                hasAnalysis: Boolean(analysis),
                hasScript: Boolean(script),
              });
              const className = status === 'active'
                ? 'bg-accent text-white'
                : status === 'complete'
                  ? 'bg-ok text-white hover:bg-ok/90'
                  : status === 'available'
                    ? 'bg-accent-tint text-accent hover:bg-accent-tint/80'
                    : 'bg-surface-subtle text-ink-tertiary';

              return (
                <div key={item} className="flex items-center gap-1.5">
                  {index > 0 && <span className="text-ink-tertiary">·</span>}
                  <button
                    type="button"
                    onClick={() => handleStepSelect(item)}
                    disabled={!canSelect}
                    title={canSelect ? `返回第 ${item} 步：${STEP_LABELS[item]}` : `第 ${item} 步还没有可用结果`}
                    aria-current={status === 'active' ? 'step' : undefined}
                    className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.7rem] font-semibold transition-colors disabled:cursor-not-allowed ${className}`}
                  >
                    {status === 'complete' ? '✓' : item}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Draft selector */}
          {drafts.length > 1 && (
            <select
              value={selectedDraftId || ''}
              onChange={(e) => handleSelectDraft(e.target.value)}
              className="input-field text-xs w-48 max-w-[min(12rem,42vw)]"
            >
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {draftLabels.get(d.id) || '未关联分镜组 · 脚本'}
                </option>
              ))}
            </select>
          )}
          {step > 1 && (
            <button onClick={handleBackToBrief} className="btn-secondary btn-sm text-xs">
              重新开始
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-5">
        {legacyDraftNotice && (
          <div className="mb-4 rounded-[18px] border border-warn/30 bg-warn-tint p-4 text-sm text-warn">
            <Icon name="alert" size={13} /> 这份脚本由旧版本生成，格式已不兼容，无法展示。请重新生成脚本。
          </div>
        )}

        {/* Step 1: Selling Point Input & Analysis */}
        {(step === 1 || (step === 2 && analyzing)) && (
          <ScriptSellingPointInput
            sellingPoints={sellingPoints}
            onSellingPointsChange={setSellingPoints}
            audience={audience}
            onAudienceChange={setAudience}
            tone={tone}
            onToneChange={setTone}
            platform={platform}
            onPlatformChange={setPlatform}
            providerId={analysisProviderId}
            onProviderIdChange={setAnalysisProviderId}
            providers={providers}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
          />
        )}

        {/* Step 2: Strategy Configuration */}
        {step === 2 && analysis && !analyzing && (
          <ScriptStrategyConfig
            analysis={analysis}
            selectedSellingPointKeys={selectedSellingPointKeys}
            onSellingPointKeysChange={setSelectedSellingPointKeys}
            templateId={templateId}
            onTemplateIdChange={(id, name) => { setTemplateId(id); setTemplateName(name); }}
            templateName={templateName}
            targetDurationSec={targetDurationSec}
            onTargetDurationSecChange={setTargetDurationSec}
            providers={providers}
            providerId={generateProviderId}
            onProviderIdChange={setGenerateProviderId}
            shotSets={shotSets}
            selectedShotSetId={selectedShotSetId}
            onShotSetIdChange={setSelectedShotSetId}
            onGenerate={handleGenerate}
            generating={generating}
          />
        )}

        {/* Step 3: Result */}
        {step === 3 && script && (
          <ScriptResultView
            script={script}
            getShotImageUrl={getShotImageUrl}
          />
        )}

        {/* Generating progress */}
        {generating && (
          <div className="mx-auto my-8 max-w-xl rounded-[20px] border border-hairline bg-surface-subtle p-5" aria-live="polite">
            <div className="mb-3 flex items-center justify-between gap-4 text-sm">
              <span className="font-medium text-ink">
                {providers.find((p) => p.id === generateProviderId)?.name || 'AI'} 正在生成脚本
              </span>
              <span className="tabular-nums text-ink-tertiary">{generationProgress.percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="脚本生成进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={generationProgress.percent}
              className="h-2 overflow-hidden rounded-full bg-hairline"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${generationProgress.percent}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <p className="text-sm text-ink-tertiary">{generationProgress.message}</p>
              <button
                type="button"
                onClick={handleCancelGeneration}
                disabled={cancellingGeneration}
                className="btn-secondary btn-sm shrink-0 text-xs"
              >
                {cancellingGeneration ? '正在取消…' : '取消生成'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
