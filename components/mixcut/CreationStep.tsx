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
  durationReview?: MixcutDurationReviewView | null;
}

export interface MixcutDurationReviewView {
  targetTotalSec: number;
  targetNarrationSec: number;
  estimatedNarrationSec: number | null;
  actualNarrationSec: number;
  actualTotalSec: number;
  deltaSec: number;
  toleranceSec: number;
  reason: 'too_short' | 'too_long';
  smartFitAvailable: boolean;
}

const STAGES = [
  { phase: 'analyzing', label: '文案拆分与素材分析' },
  { phase: 'synthesizing', label: '逐句口播生成' },
  { phase: 'duration_check', label: '真实口播时长校验' },
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

function stageState(job: MixcutPrepareJobView | null, index: number): 'waiting' | 'running' | 'review' | 'done' | 'failed' {
  if (!job) return 'waiting';
  const activePhase = job.phase === 'duration_review' ? 'duration_check' : job.phase;
  const currentIndex = STAGES.findIndex((stage) => stage.phase === activePhase);
  if (job.status === 'failed') {
    if (currentIndex === index || (currentIndex < 0 && index === 0)) return 'failed';
    return currentIndex > index ? 'done' : 'waiting';
  }
  if (job.status === 'succeeded') return 'done';
  if (job.status === 'needs_input') {
    if (currentIndex === index) return 'review';
    return currentIndex > index ? 'done' : 'waiting';
  }
  if (currentIndex === index) return 'running';
  return currentIndex > index ? 'done' : 'waiting';
}

// V2 第 2 步（规格 §5）：单列卡片流——口播文案卡 → 音色卡 → CTA 区 → 进度卡。
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
  onResolveDuration,
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
  onResolveDuration: (action: 'smart_fit' | 'retry_with_changes' | 'accept_actual') => void;
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
  const selectedVoice = provider?.voices.find((item) => item.id === voice) ?? null;
  const charCount = Array.from(editedNarrationText.replace(/\s/g, '')).length;
  const busy = submitting || Boolean(job && ['queued', 'running'].includes(job.status));
  const progress = Math.max(0, Math.min(1, Number(job?.progress) || 0));
  const durationReview = job?.status === 'needs_input' && job.phase === 'duration_review' ? job.durationReview : null;
  const largeOverrun = Boolean(durationReview?.reason === 'too_long' && durationReview.actualTotalSec >= durationReview.targetTotalSec * 1.5);

  const auditionVoice = (voiceId: string) => {
    if (voiceId !== voice) onVoiceChange(voiceId);
    onPreviewVoice();
  };

  return (
    <>
      <div className={`${styles.stepScroll} ${styles.stepScrollGap24}`} style={{ paddingTop: 14 }}>
        {/* 口播文案卡 */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}><Icon name="mic" size={16} />口播文案 <span style={{ fontWeight: 400, color: 'var(--sub)', fontSize: 12 }}>（目标总时长包含封面）</span></div>
            <div className={styles.flowHint}>输入文案 → 选音色 → AI 匹配画面 → 出片</div>
          </div>
          {drafts.length > 0 ? (
            <label className={styles.field}>
              <span>脚本版本（模块 3 · 仅显示当前分镜组的有效草稿）
                <span className={modified ? styles.chipGrey : styles.chipGreen} style={{ marginLeft: 8 }}>{modified ? '已手动修改' : '已同步'}{dirty ? '，待保存' : ''}</span>
              </span>
              <select value={activeDraftId} onChange={(event) => onDraftChange(event.target.value)} disabled={busy}>
                {drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title || '未命名脚本'} · {draft.targetDurationSec}s · {draft.provider}/{draft.model} · {formatCreatedAt(draft.createdAt)}</option>)}
              </select>
            </label>
          ) : <div className={styles.warningNotice}>当前组还没有模块 3 脚本，可以先手动输入口播文案。</div>}
          <label className={styles.field}>
            <span>口播文案</span>
            <textarea value={editedNarrationText} onChange={(event) => onTextChange(event.target.value)} disabled={busy} placeholder="输入 15～30 秒口播文案…" />
          </label>
          <div className={styles.metaRow}>
            <span>{charCount}/500 字（约 {estimateNarrationSec(editedNarrationText, speed)} 秒口播）</span>
            <span>来源：{activeDraft ? `${activeDraft.provider} / ${activeDraft.model}` : '手动输入'}</span>
            {importedNarrationText && <button type="button" className={styles.linkBtn} onClick={onRestoreImported} disabled={!modified || busy}>恢复导入版本</button>}
          </div>
        </section>

        {/* 音色选择卡 */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}><Icon name="speaker" size={16} />选择朗读音色</div>
              <div className={styles.cardSub}>当前服务商：{provider ? `${provider.name} · ${provider.model}` : '未配置'}（密钥{provider?.configured ? '已配置' : '未配置'}）</div>
            </div>
            <select style={{ minWidth: 200 }} value={providerId} onChange={(event) => onProviderChange(event.target.value)} disabled={busy} aria-label="配音服务">
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
            </select>
          </div>
          <div className={styles.rateRow}>
            <span className={styles.rateLab}>语速</span>
            <input type="range" min="0.5" max="2" step="0.1" value={speed} onChange={(event) => onSpeedChange(Number(event.target.value))} disabled={busy} aria-label="语速" />
            <span className={`${styles.chip} ${styles.chipGrey}`}>{speed.toFixed(1)}x</span>
            <span className={styles.rateHint}>0.5x 慢速 · 1.0x 正常 · 2.0x 快速</span>
          </div>
          <div className={styles.cardSub}>精选音色（点击选中，可单独试听）</div>
          <div className={styles.voiceGrid}>
            {voices.map((item) => (
              <div key={item.id} role="button" tabIndex={0} className={`${styles.voice} ${item.id === voice ? styles.voiceOn : ''}`}
                onClick={() => !busy && onVoiceChange(item.id)}
                onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !busy) onVoiceChange(item.id); }}>
                <div className={styles.voiceVi}><Icon name="mic" size={18} /></div>
                <div className={styles.voiceN}>{item.label}</div>
                <div className={styles.voiceI}>{item.id}</div>
                <button type="button" className={styles.voiceTry} disabled={previewingVoice || !provider?.configured || busy} onClick={(event) => { event.stopPropagation(); auditionVoice(item.id); }}>
                  <Icon name="play" size={9} />{previewingVoice && item.id === voice ? '生成中…' : '试听'}
                </button>
              </div>
            ))}
          </div>
          <div className={styles.moreRow}>
            <span className={styles.field} style={{ margin: 0, flex: 1, minWidth: 180 }}><input type="text" value={voiceQuery} onChange={(event) => setVoiceQuery(event.target.value)} placeholder="搜索更多音色（名称或 ID）" /></span>
            {(provider?.voices.length ?? 0) > 6 && !voiceQuery && <button type="button" className={styles.linkBtn} onClick={() => setShowAllVoices((value) => !value)}>{showAllVoices ? '收起音色' : `查看全部 ${provider?.voices.length} 个音色`}</button>}
            <span className={styles.flowHint}>当前选中：{selectedVoice ? `${selectedVoice.label} · ${selectedVoice.id}` : '未选择'}</span>
          </div>
        </section>

        {/* CTA 区 */}
        <div className={styles.ctaZone}>
          {job?.status === 'succeeded'
            ? <button type="button" className={`${styles.btn} ${styles.primary} ${styles.big}`} onClick={onPreview}><Icon name="play-circle" size={17} />去预览调整</button>
            : job?.status === 'needs_input'
              ? <span className={`${styles.chip} ${styles.chipGrey}`}><Icon name="alert" size={13} />等待确认真实口播时长</span>
            : <button type="button" className={`${styles.btn} ${styles.primary} ${styles.big}`} onClick={onStart} disabled={busy || Boolean(startDisabledReason)}><Icon name="sparkle" size={17} />{submitting ? '正在创建任务…' : busy ? '正在创作…' : job?.status === 'failed' ? '重新创作' : '开始智能创作'}</button>}
          <span className={`${styles.chip} ${styles.chipGreen}`}><Icon name="film" size={12} />可用视频素材：{selectedMaterialCount} 个</span>
          <span className={styles.flowHint}>{startDisabledReason || '开始后会创建不可变任务快照，刷新页面不会丢失。'}</span>
        </div>

        {durationReview && (
          <section className={styles.card} aria-label="真实口播时长处理">
            <div className={styles.cardHead}>
              <div>
                <div className={styles.cardTitle}><Icon name="alert" size={16} />真实口播时长需要确认</div>
                <div className={styles.cardSub}>TTS 和自动字幕已经保存；确认前不会进入素材匹配，也不会生成成片草稿。</div>
              </div>
              <span className={`${styles.chip} ${styles.chipGrey}`}>{durationReview.reason === 'too_long' ? '超出目标' : '低于目标'}</span>
            </div>
            <div className={styles.durationReviewGrid}>
              <div><span>目标总时长</span><strong>{durationReview.targetTotalSec.toFixed(2)} 秒</strong></div>
              <div><span>实际总时长</span><strong>{durationReview.actualTotalSec.toFixed(2)} 秒</strong></div>
              <div><span>偏差</span><strong>{durationReview.deltaSec > 0 ? '+' : ''}{durationReview.deltaSec.toFixed(2)} 秒</strong></div>
              <div><span>容差</span><strong>±{durationReview.toleranceSec.toFixed(2)} 秒</strong></div>
              <div><span>目标正文</span><strong>{durationReview.targetNarrationSec.toFixed(2)} 秒</strong></div>
              <div><span>预计正文</span><strong>{durationReview.estimatedNarrationSec == null ? '—' : `${durationReview.estimatedNarrationSec.toFixed(2)} 秒`}</strong></div>
            </div>
            {largeOverrun && <div className={styles.warningNotice} style={{ marginTop: 12 }}>当前偏差较大，不能只靠自动加速解决；请优先智能贴合或精简口播文案。</div>}
            <div className={styles.durationReviewActions}>
              <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={submitting || !durationReview.smartFitAvailable} onClick={() => onResolveDuration('smart_fit')}><Icon name="sparkle" size={14} />{durationReview.smartFitAvailable ? '智能贴合时长' : '智能贴合已使用'}</button>
              <button type="button" className={styles.btn} disabled={submitting || !editedNarrationText.trim()} onClick={() => onResolveDuration('retry_with_changes')}><Icon name="retry" size={14} />修改文案或语速后重试</button>
              <button type="button" className={styles.btn} disabled={submitting} onClick={() => onResolveDuration('accept_actual')}>按实际时长继续</button>
            </div>
          </section>
        )}

        {/* 进度卡 */}
        <section className={styles.card} aria-label="智能创作进度">
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>处理进度</div>
            <div className={styles.flowHint}>{job ? `${STAGES.find((stage) => stage.phase === job.phase)?.label ?? ''} · 已用时 ${elapsedSec}s` : `已选 ${selectedMaterialCount} 个素材`}</div>
          </div>
          <div className={styles.progBar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} style={{ marginBottom: 14 }}><i style={{ width: `${progress * 100}%` }} /></div>
          {STAGES.map((stage, index) => {
            const state = stageState(job, index);
            const cls = state === 'done' ? styles.pipeDone : state === 'running' || state === 'review' ? styles.pipeDoing : state === 'failed' ? styles.pipeFail : styles.pipeWait;
            return (
              <div key={stage.phase} className={`${styles.pipe} ${cls}`} data-state={state}>
                <span className={styles.pipeIc}>{state === 'done' ? <Icon name="check" size={12} /> : state === 'running' ? <Icon name="play" size={9} /> : state === 'review' || state === 'failed' ? '!' : index + 1}</span>
                <span className={styles.pipeNm}>{stage.label}</span>
                <span className={styles.pipeSt}>{state === 'done' ? '已完成' : state === 'running' ? '进行中' : state === 'review' ? '需要处理' : state === 'failed' ? '失败' : '等待'}</span>
              </div>
            );
          })}
          {job?.errorMessage && <div className={styles.errorNotice}><Icon name="alert" size={15} />{job.errorMessage}</div>}
          {job?.status === 'succeeded' && <div className={styles.successNotice}><Icon name="check" size={15} />准备任务已完成，脚本和进度已保存到本地。</div>}
        </section>
      </div>

      {pendingDraft && (
        <div className={styles.switchDialogBackdrop} role="presentation">
          <div className={styles.switchDialog} role="dialog" aria-modal="true" aria-labelledby="mixcut-switch-title">
            <h2 id="mixcut-switch-title">当前脚本有未保存修改</h2>
            <p>切换到「{pendingDraft.title || '未命名脚本'}」前，请选择如何处理当前文案。</p>
            <div><button type="button" className={styles.primaryButton} onClick={() => onResolveDraftSwitch('preserve')}>保留修改并切换</button><button type="button" className={styles.secondaryButton} onClick={() => onResolveDraftSwitch('discard')}>放弃修改并切换</button><button type="button" className={styles.textButton} onClick={() => onResolveDraftSwitch('cancel')}>取消</button></div>
          </div>
        </div>
      )}
    </>
  );
}
