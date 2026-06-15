'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';
import ScriptSellingPointInput from './ScriptSellingPointInput';
import ScriptStrategyConfig from './ScriptStrategyConfig';
import ScriptResultView from './ScriptResultView';
import { canNavigateToScriptStep, getScriptStepStatus, type ScriptStep } from '@/lib/script-workflow';
import type { AnalysisResult, ProviderMeta, ScriptOutput } from '@/lib/script-providers';

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

// ── Component ──

export default function ScriptPanel({ projectId }: Props) {
  // ── Core state ──
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  // Brief (from project)
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('种草');
  const [platform, setPlatform] = useState('通用');
  const [sellingPoints, setSellingPoints] = useState('');

  // Analysis
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisProviderId, setAnalysisProviderId] = useState('gemini');
  const [analyzing, setAnalyzing] = useState(false);

  // Strategy
  const [selectedSellingPoints, setSelectedSellingPoints] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState('scene_seeding');
  const [templateName, setTemplateName] = useState('场景种草');
  const [duration, setDuration] = useState('30s');
  const [generateProviderId, setGenerateProviderId] = useState('gemini');

  // ShotSet selection
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [selectedShotSetId, setSelectedShotSetId] = useState('');

  // Result
  const [script, setScript] = useState<ScriptOutput | null>(null);
  const [drafts, setDrafts] = useState<ScriptDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [shotImages, setShotImages] = useState<ShotWithImage[]>([]);

  // Models
  const [providers, setProviders] = useState<ProviderMeta[]>([]);

  // Refs
  const initialLoadDone = useRef(false);

  const hydrateStrategyFromDraft = useCallback((draft: ScriptDraft) => {
    try {
      const snapshot = JSON.parse(draft.inputSnapshot || '{}') as {
        selectedSellingPoints?: Array<{ title?: string }>;
        templateId?: string;
        templateName?: string;
        duration?: string;
        shotSetId?: string;
        providerId?: string;
        tone?: string;
        platform?: string;
      };

      const titles = Array.isArray(snapshot.selectedSellingPoints)
        ? snapshot.selectedSellingPoints.map((s) => s.title).filter((title): title is string => Boolean(title))
        : [];

      setSelectedSellingPoints(titles);
      if (snapshot.templateId) setTemplateId(snapshot.templateId);
      if (snapshot.templateName) setTemplateName(snapshot.templateName);
      if (snapshot.duration) setDuration(snapshot.duration);
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

  // ── Initial load ──
  useEffect(() => {
    let active = true;

    const run = async () => {
      try {
        const [projRes, draftRes, modelRes, shotSetRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`),
          fetch(`/api/projects/${projectId}/script`),
          fetch(`/api/projects/${projectId}/script?action=models`),
          fetch(`/api/projects/${projectId}/shot-sets`),
        ]);

        const projData = await projRes.json().catch(() => ({}));
        const draftData = await draftRes.json().catch(() => ({ drafts: [], analysis: null }));
        const modelData = await modelRes.json().catch(() => ({ providers: [] }));
        const shotSetData = await shotSetRes.json().catch(() => []);

        if (!active) return;

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
          setAnalysis(draftData.analysis);
          setSelectedSellingPoints((current) => {
            if (current.length > 0) return current;
            const rankings = (draftData.analysis as AnalysisResult).rankings || [];
            return rankings.slice(0, 3).map((r) => r.title);
          });
          setStep(2);
        }

        // Drafts
        if (draftData.drafts?.length > 0) {
          setDrafts(draftData.drafts);
          if (!initialLoadDone.current) {
            initialLoadDone.current = true;
            const first = draftData.drafts[0] as ScriptDraft;
            setSelectedDraftId(first.id);
            hydrateStrategyFromDraft(first);
            try {
              const parsed = JSON.parse(first.outputJson) as ScriptOutput;
              setScript(parsed);
              setStep(3);
              if (parsed.shotSetId) {
                void loadShotImages(parsed.shotSetId);
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

        // P2: Default provider to the first configured one (not always gemini)
        if (modelData.providers?.length > 0) {
          const configured = (modelData.providers as ProviderMeta[]).find((p) => p.configured);
          if (configured && configured.id !== 'gemini') {
            setAnalysisProviderId(configured.id);
            setGenerateProviderId(configured.id);
          }
        }
      } catch {
        if (active) setLoading(false);
      }
    };

    run();
    return () => { active = false; };
  }, [projectId, hydrateStrategyFromDraft, loadShotImages]);

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
        setAnalysis(data.analysis);
        // Pre-select top 3
        setSelectedSellingPoints(
          (data.analysis as AnalysisResult).rankings.slice(0, 3).map((r: { title: string }) => r.title)
        );
        setStep(2);
      } else {
        alert('分析失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      alert('分析失败: ' + String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [projectId, sellingPoints, audience, platform, analysisProviderId, saveBrief]);

  // ── Handle generate ──
  const handleGenerate = useCallback(async () => {
    if (!selectedShotSetId) {
      alert('请选择一个分镜组');
      return;
    }
    if (selectedSellingPoints.length === 0) {
      alert('请至少选择一个卖点');
      return;
    }

    setGenerating(true);
    try {
      await saveBrief();

      // Build selected selling points with analysis data
      const spWithData = selectedSellingPoints.map((title) => {
        const rank = analysis?.rankings?.find((r) => r.title === title);
        return {
          title,
          priority: rank?.priority || 'medium',
          reason: rank?.reason || '',
        };
      });

      const res = await fetch(`/api/projects/${projectId}/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          shotSetId: selectedShotSetId,
          selectedSellingPoints: spWithData,
          templateId,
          templateName,
          duration,
          providerId: generateProviderId,
          tone,
          platform,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setScript(data.script);
        setStep(3);

        // Reload drafts
        const listRes = await fetch(`/api/projects/${projectId}/script`);
        const listData = await listRes.json().catch(() => ({ drafts: [] }));
        if (listData.drafts?.length > 0) {
          setDrafts(listData.drafts);
          setSelectedDraftId(listData.drafts[0].id);
        }

        // Load shot images for the result view
        await loadShotImages(selectedShotSetId);
      } else {
        alert('生成失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      alert('生成失败: ' + String(err));
    } finally {
      setGenerating(false);
    }
  }, [
    projectId, selectedShotSetId, selectedSellingPoints, analysis,
    templateId, templateName, duration, generateProviderId,
    tone, platform, saveBrief, loadShotImages,
  ]);

  // ── Handle selecting a draft ──
  const handleSelectDraft = useCallback((draftId: string) => {
    const draft = drafts.find((d) => d.id === draftId);
    if (draft) {
      setSelectedDraftId(draftId);
      hydrateStrategyFromDraft(draft);
      try {
        const parsed = JSON.parse(draft.outputJson) as ScriptOutput;
        setScript(parsed);
        setStep(3);
        if (parsed.shotSetId) {
          void loadShotImages(parsed.shotSetId);
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
              className="input-field text-xs w-44"
            >
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {new Date(d.createdAt + 'Z').toLocaleString('zh-CN')}
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
            selectedSellingPoints={selectedSellingPoints}
            onSellingPointsChange={setSelectedSellingPoints}
            templateId={templateId}
            onTemplateIdChange={(id, name) => { setTemplateId(id); setTemplateName(name); }}
            templateName={templateName}
            duration={duration}
            onDurationChange={setDuration}
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
            projectId={projectId}
          />
        )}

        {/* Generating spinner overlay */}
        {generating && (
          <div className="py-12 text-center text-ink-tertiary">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="text-sm">
              {providers.find((p) => p.id === generateProviderId)?.name || 'AI'} 正在生成脚本...
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
