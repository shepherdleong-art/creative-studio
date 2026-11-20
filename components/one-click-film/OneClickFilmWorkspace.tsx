'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageToolbar from '@/components/team/PageToolbar';
import { EmptyState, Segmented, Tag } from '@/components/ui/Appearance';
import { UploadStage } from './UploadStage';
import { AnalysisStage } from './AnalysisStage';
import { ScriptStage } from './ScriptStage';
import { GenerationStage } from './GenerationStage';
import { ReviewStage } from './ReviewStage';
import { PackagingStage } from './PackagingStage';
import {
  analysisSourceIds,
  parseStageTab,
  STAGE_TABS,
  type FilmState,
  type StageTabId,
} from './types';
import styles from './one-click-film.module.css';

/**
 * 一键成片工作台（第一版纵向切片）：上传素材 → 分析内容 → 生成脚本。
 * 三个阶段共用同一个项目上下文，往返时保留本次编辑。
 */
export function OneClickFilmWorkspace({ projectId }: { projectId: string }) {
  const params = useSearchParams();
  const [stage, setStage] = useState<StageTabId>(() => parseStageTab(params.get('stage')));
  const [state, setState] = useState<FilmState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/one-click-film/${projectId}`, { cache: 'no-store' });
      const body = await response.json() as FilmState & { message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || '读取项目失败');
      setState(body);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // 首次进入拉取项目上下文；reload 内部异步更新，不在 effect 体内同步 setState。
    const timer = setTimeout(() => { void reload(); }, 0);
    return () => clearTimeout(timer);
  }, [reload]);

  const analyze = async () => {
    if (!state) return;
    setAnalyzing(true);
    setError('');
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', imageIds: analysisSourceIds(state) }),
      });
      const body = await response.json() as { message?: string; error?: string };
      await reload();
      setStage('analysis');
      if (!response.ok) setError(body.message || body.error || '分析失败');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return <div className={styles.center}><div className={styles.spinner} />加载项目中…</div>;
  }

  if (!state) {
    return <div className={styles.center}>
      <EmptyState icon="alert" title="读不到这个项目" description={error || '项目可能已被删除，或你没有访问权限。'} />
    </div>;
  }

  const confirmed = state.analysis?.confirmedAt ?? null;

  return <div className={styles.workspace}>
    <PageToolbar
      role="employee"
      title="一键成片"
      subtitle={state.project.name}
      actions={<div className={styles.headStatus}>
        <Tag tone="idle">{state.images.length} 份素材</Tag>
        <Tag tone={confirmed ? 'ok' : 'warn'}>{confirmed ? '分析已确认' : '待确认分析'}</Tag>
        <Tag tone="idle">{state.entries.length} 条成片</Tag>
      </div>}
    />

    <div className={styles.tabs}>
      <Segmented<StageTabId>
        value={stage}
        onChange={setStage}
        label="一键成片子页"
        options={STAGE_TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
      />
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </div>

    {stage === 'upload' ? <UploadStage
      state={state}
      busy={analyzing}
      onChange={reload}
      onAnalyze={() => void analyze()}
      onOpenAnalysis={() => setStage('analysis')}
    /> : null}

    {stage === 'analysis' ? <AnalysisStage
      state={state}
      busy={analyzing}
      onBack={() => setStage('upload')}
      onReanalyze={() => void analyze()}
      onConfirmed={() => { void reload(); setStage('scripts'); }}
    /> : null}

    {stage === 'scripts' ? <ScriptStage
      state={state}
      busy={false}
      onReload={reload}
    /> : null}

    {stage === 'generation' ? <GenerationStage state={state} entries={state.entries} /> : null}

    {stage === 'review' ? <ReviewStage state={state} /> : null}

    {stage === 'packaging' ? <PackagingStage state={state} /> : null}
  </div>;
}
