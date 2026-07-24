'use client';

import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { MixcutContextResponse } from '@/lib/final-edit/types';
import type { ScriptSwitchResolution } from '@/lib/final-edit/mixcut-creation-state';
import styles from './MixcutPanel.module.css';

type Draft = MixcutContextResponse['drafts'][number];

export interface MixcutTtsProviderView {
  id: string;
  name: string;
  model: string;
  enabled: number | boolean;
  hasApiKey: boolean;
  configured: boolean;
  voices: Array<{ id: string; label: string }>;
}

export interface MixcutPrepareJobView {
  id: string;
  groupId: string;
  status: string;
  phase: string;
  progress: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

const STAGES = [
  { phase: 'analyzing', label: '文案拆分与素材分析' },
  { phase: 'synthesizing', label: '逐句口播生成' },
  { phase: 'matching', label: '节拍检测与场景匹配' },
  { phase: 'previewing', label: '预热可预览草稿' },
] as const;

function formatCreatedAt(value: string): string {
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function estimateNarrationSec(text: string, speed: number): number {
  const count = Array.from(text.replace(/\s/g, '')).length;
  return Math.round(count * 0.22 / Math.max(0.5, speed));
}

function stageState(job: MixcutPrepareJobView | null, index: number): 'waiting' | 'running' | 'done' | 'failed' {
  if (!job) return 'waiting';
  const currentIndex = STAGES.findIndex((stage) => stage.phase === job.phase);
  if (job.status === 'failed') {
    if (currentIndex === index || (currentIndex < 0 && index === 0)) return 'failed';
    return currentIndex > index ? 'done' : 'waiting';
  }
  if (job.status === 'succeeded') return 'done';
  if (currentIndex === index) return 'running';
  return currentIndex > index ? 'done' : 'waiting';
}

export function CreationStep({
  drafts,
  activeDraftId,
  editedNarrationText,
  importedNarrationText,
  dirty,
  modified,
  pendingDraft,
  onDraftChange,
  onResolveDraftSwitch,
  onTextChange,
  onRestoreImported,
  providers,
  providerId,
  voice,
  speed,
  onProviderChange,
  onVoiceChange,
  onSpeedChange,
  onPreviewVoice,
  previewingVoice,
  selectedMaterialCount,
  job,
  elapsedSec,
  onStart,
  onPreview,
  onBack,
  submitting,
  startDisabledReason,
}: {
  drafts: Draft[];
  activeDraftId: string;
  editedNarrationText: string;
  importedNarrationText: string;
  dirty: boolean;
  modified: boolean;
  pendingDraft: Draft | null;
  onDraftChange: (draftId: string) => void;
  onResolveDraftSwitch: (resolution: ScriptSwitchResolution) => void;
  onTextChange: (text: string) => void;
  onRestoreImported: () => void;
  providers: MixcutTtsProviderView[];
  providerId: string;
  voice: string;
  speed: number;
  onProviderChange: (providerId: string) => void;
  onVoiceChange: (voice: string) => void;
  onSpeedChange: (speed: number) => void;
  onPreviewVoice: () => void;
  previewingVoice: boolean;
  selectedMaterialCount: number;
  job: MixcutPrepareJobView | null;
  elapsedSec: number;
  onStart: () => void;
  onPreview: () => void;
  onBack: () => void;
  submitting: boolean;
  startDisabledReason?: string;
}) {
  const [voiceQuery, setVoiceQuery] = useState('');
  const [showAllVoices, setShowAllVoices] = useState(false);
  const provider = providers.find((item) => item.id === providerId) ?? providers[0] ?? null;
  const voices = useMemo(() => {
    const query = voiceQuery.trim().toLowerCase();
    const filtered = (provider?.voices ?? []).filter((item) => !query || `${item.label} ${item.id}`.toLowerCase().includes(query));
    return showAllVoices || query ? filtered : filtered.slice(0, 6);
  }, [provider, showAllVoices, voiceQuery]);
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const charCount = Array.from(editedNarrationText.replace(/\s/g, '')).length;
  const busy = submitting || Boolean(job && ['queued', 'running'].includes(job.status));
  const progress = Math.max(0, Math.min(1, Number(job?.progress) || 0));

  return (
    <section className={styles.creationStep} aria-labelledby="mixcut-creation-heading">
      <header className={styles.stepHeader}>
        <div>
          <p className={styles.eyebrow}>STEP 02</p>
          <h1 id="mixcut-creation-heading">编辑口播并启动智能创作</h1>
          <p>脚本、音色和素材选择会一起冻结到本次后台任务。</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onBack} disabled={busy}>
          <Icon name="chevron-left" size={15} />返回素材
        </button>
      </header>

      <div className={styles.creationStack}>
        <section className={styles.creationCard}>
          <div className={styles.cardTitleRow}>
            <div><span className={styles.cardIcon}><Icon name="file-text" size={17} /></span><span><strong>模块 3 脚本</strong><small>仅显示当前分镜组的有效草稿</small></span></div>
            <span className={modified ? styles.modifiedBadge : styles.syncedBadge}>{modified ? '已手动修改' : '已同步'}{dirty ? '，待保存' : ''}</span>
          </div>

          {drafts.length > 0 ? (
            <label className={styles.fieldLabel}>
              <span>脚本版本</span>
              <select value={activeDraftId} onChange={(event) => onDraftChange(event.target.value)} disabled={busy}>
                {drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title || '未命名脚本'} · {draft.targetDurationSec}s · {draft.provider}/{draft.model} · {formatCreatedAt(draft.createdAt)}</option>)}
              </select>
            </label>
          ) : <div className={styles.warningNotice}>当前组还没有模块 3 脚本，可以先手动输入口播文案。</div>}

          <label className={styles.fieldLabel}>
            <span>口播文案</span>
            <textarea value={editedNarrationText} onChange={(event) => onTextChange(event.target.value)} disabled={busy} placeholder="输入 15～30 秒口播文案…" />
          </label>
          <div className={styles.scriptMeta}>
            <span>{charCount} 字 · 预计 {estimateNarrationSec(editedNarrationText, speed)} 秒</span>
            <span>来源：{activeDraft ? `${activeDraft.provider} / ${activeDraft.model}` : '手动输入'}</span>
            {importedNarrationText && <button type="button" onClick={onRestoreImported} disabled={!modified || busy}>恢复导入版本</button>}
          </div>
        </section>

        <section className={styles.creationCard}>
          <div className={styles.cardTitleRow}>
            <div><span className={styles.cardIcon}><Icon name="users" size={17} /></span><span><strong>口播音色</strong><small>供应商密钥只显示配置状态</small></span></div>
            <span className={provider?.configured ? styles.syncedBadge : styles.modifiedBadge}>{provider?.configured ? '已配置' : '未配置'}</span>
          </div>
          <div className={styles.voiceControls}>
            <label className={styles.fieldLabel}><span>配音服务</span><select value={providerId} onChange={(event) => onProviderChange(event.target.value)} disabled={busy}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
            <label className={styles.fieldLabel}><span>搜索音色</span><span className={styles.searchField}><Icon name="search" size={15} /><input value={voiceQuery} onChange={(event) => setVoiceQuery(event.target.value)} placeholder="输入名称或 ID" /></span></label>
          </div>
          <div className={styles.voiceGrid}>
            {voices.map((item) => <button type="button" key={item.id} className={item.id === voice ? styles.voiceSelected : ''} onClick={() => onVoiceChange(item.id)} disabled={busy}><strong>{item.label}</strong><small>{item.id}</small></button>)}
          </div>
          {(provider?.voices.length ?? 0) > 6 && !voiceQuery && <button type="button" className={styles.textButton} onClick={() => setShowAllVoices((value) => !value)}>{showAllVoices ? '收起音色' : `查看全部 ${provider?.voices.length} 个音色`}</button>}
          <div className={styles.speedRow}>
            <label><span>语速</span><input type="range" min="0.5" max="2" step="0.1" value={speed} onChange={(event) => onSpeedChange(Number(event.target.value))} disabled={busy} /><strong>{speed.toFixed(1)}x</strong></label>
            <button type="button" className={styles.secondaryButton} onClick={onPreviewVoice} disabled={previewingVoice || !provider?.configured || busy}><Icon name="play" size={14} />{previewingVoice ? '生成中…' : '试听当前'}</button>
          </div>
        </section>

        <section className={styles.creationCard} aria-label="智能创作进度">
          <div className={styles.cardTitleRow}>
            <div><span className={styles.cardIcon}><Icon name="sparkle" size={17} /></span><span><strong>真实后台进度</strong><small>{job ? `已用时 ${elapsedSec} 秒` : `已选 ${selectedMaterialCount} 个素材`}</small></span></div>
            {job && <strong>{Math.round(progress * 100)}%</strong>}
          </div>
          <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${progress * 100}%` }} /></div>
          <div className={styles.stageList}>
            {STAGES.map((stage, index) => {
              const state = stageState(job, index);
              return <div key={stage.phase} data-state={state}><span>{state === 'done' ? '✓' : state === 'running' ? '▶' : state === 'failed' ? '!' : index + 1}</span><strong>{stage.label}</strong><small>{state === 'done' ? '已完成' : state === 'running' ? '进行中' : state === 'failed' ? '失败' : '等待'}</small></div>;
            })}
          </div>
          {job?.errorMessage && <div className={styles.errorNotice}><Icon name="alert" size={15} />{job.errorMessage}</div>}
          {job?.status === 'succeeded' && <div className={styles.successNotice}><Icon name="check" size={15} />准备任务已完成，脚本和进度已保存到本地。</div>}
        </section>
      </div>

      <footer className={styles.creationFooter}>
        <span>{startDisabledReason || '开始后会创建不可变任务快照，刷新页面不会丢失。'}</span>
        {job?.status === 'succeeded'
          ? <button type="button" className={styles.primaryButton} onClick={onPreview}><Icon name="play" size={16} />去预览调整</button>
          : <button type="button" className={styles.primaryButton} onClick={onStart} disabled={busy || Boolean(startDisabledReason)}><Icon name="sparkle" size={16} />{submitting ? '正在创建任务…' : busy ? '正在创作…' : job?.status === 'failed' ? '重新创作' : '开始智能创作'}</button>}
      </footer>

      {pendingDraft && (
        <div className={styles.switchDialogBackdrop} role="presentation">
          <div className={styles.switchDialog} role="dialog" aria-modal="true" aria-labelledby="mixcut-switch-title">
            <h2 id="mixcut-switch-title">当前脚本有未保存修改</h2>
            <p>切换到「{pendingDraft.title || '未命名脚本'}」前，请选择如何处理当前文案。</p>
            <div><button type="button" className={styles.primaryButton} onClick={() => onResolveDraftSwitch('preserve')}>保留修改并切换</button><button type="button" className={styles.secondaryButton} onClick={() => onResolveDraftSwitch('discard')}>放弃修改并切换</button><button type="button" className={styles.textButton} onClick={() => onResolveDraftSwitch('cancel')}>取消</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
