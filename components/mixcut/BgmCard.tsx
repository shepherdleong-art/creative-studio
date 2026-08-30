'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { VariantCommandInput } from '@/components/final-edit/command-types';
import { Icon } from '@/components/ui/Icon';
import type { FinalEditBgmTrackView, FinalEditVariantView } from '@/lib/final-edit/types';
import styles from './mixcut-content.module.css';

const ACCEPTED_AUDIO = '.mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*';

type VariantCommandRequest = VariantCommandInput | ((variant: FinalEditVariantView) => VariantCommandInput);

export type BgmImportOutcome = 'applied' | 'imported' | 'failed';
export interface BgmImportUiResult {
  outcome: BgmImportOutcome;
  announcement: string;
  details: string;
}

export function BgmCard({
  scopeId,
  tracks,
  bgm,
  revision,
  disabled,
  active,
  stopRequestId,
  onAuditionStart,
  onCommand,
  onGainPreview,
  onGainCommit,
  onImportFiles,
}: {
  scopeId: string;
  tracks: FinalEditBgmTrackView[];
  bgm: FinalEditVariantView['bgm'];
  revision: number;
  disabled: boolean;
  active: boolean;
  stopRequestId: number;
  onAuditionStart: () => void;
  onCommand: (request: VariantCommandRequest) => Promise<boolean>;
  onGainPreview: (gainDb: number) => void;
  onGainCommit: (gainDb: number) => Promise<boolean>;
  onImportFiles: (files: File[]) => Promise<BgmImportUiResult>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [importing, setImporting] = useState(false);
  const [auditioning, setAuditioning] = useState(false);
  const [status, setStatus] = useState('');
  const [bgmGainDraft, setBgmGainDraft] = useState(bgm.gainDb);
  const bgmGainPendingRef = useRef<number | null>(null);

  const selectedTrackId = bgm.trackId || '';
  const selectedTrackName = tracks.find((track) => track.id === selectedTrackId)?.filename || '';

  const pauseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, []);

  const stopAudition = useCallback(() => {
    pauseAudio();
    setAuditioning(false);
  }, [pauseAudio]);

  const showStatus = useCallback((message: string) => {
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
    setStatus(message);
    statusTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setStatus('');
      statusTimeoutRef.current = null;
    }, 2400);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    pauseAudio();
  }, [scopeId, selectedTrackId, pauseAudio]);

  useEffect(() => {
    if (active) return;
    pauseAudio();
  }, [active, pauseAudio]);

  useEffect(() => {
    pauseAudio();
  }, [stopRequestId, pauseAudio]);

  useEffect(() => {
    bgmGainPendingRef.current = null;
    const timer = window.setTimeout(() => setBgmGainDraft(bgm.gainDb), 0);
    return () => window.clearTimeout(timer);
  }, [bgm.gainDb, revision, scopeId]);

  useEffect(() => () => {
    const audio = audioRef.current;
    audio?.pause();
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
  }, []);

  const chooseTrack = (trackId: string) => {
    stopAudition();
    void onCommand({ type: 'set_bgm', trackId: trackId || null });
  };

  const previewBgmGain = (nextValue: number) => {
    const next = Number.isFinite(nextValue) ? Math.min(0, Math.max(-40, nextValue)) : 0;
    bgmGainPendingRef.current = next;
    setBgmGainDraft(next);
    onGainPreview(next);
  };

  const commitBgmGain = (nextValue: number) => {
    const next = Number.isFinite(nextValue) ? Math.min(0, Math.max(-40, nextValue)) : 0;
    const persistedGainDb = bgm.gainDb;
    bgmGainPendingRef.current = null;
    setBgmGainDraft(next);
    void onGainCommit(next).then((accepted) => {
      if (!accepted && mountedRef.current) setBgmGainDraft(persistedGainDb);
    }).catch(() => {
      if (mountedRef.current) setBgmGainDraft(persistedGainDb);
    });
  };

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (!files.length) return;
    setImporting(true);
    try {
      if (!mountedRef.current) return;
      const result = await onImportFiles(files);
      if (!mountedRef.current) return;
      if (result.outcome === 'applied') {
        showStatus(result.announcement);
      } else if (result.outcome === 'imported') {
        showStatus(result.announcement);
      } else {
        showStatus('添加失败');
      }
    } catch {
      if (mountedRef.current) showStatus('添加失败，请重试');
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  const toggleAudition = async () => {
    if (auditioning) {
      stopAudition();
      return;
    }
    const audio = audioRef.current;
    if (!audio || !selectedTrackId) return;
    onAuditionStart();
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    try {
      await audio.play();
      if (mountedRef.current) setAuditioning(true);
    } catch {
      if (mountedRef.current) setAuditioning(false);
      showStatus(`无法试听"${selectedTrackName || '当前音乐'}"，请检查文件是否可播放`);
    }
  };

  return (
    <section className={`${styles.rcard} ${styles.bgmCard}`} data-testid="mixcut-bgm-card">
      <h4>
        <Icon name="music" size={15} />
        背景音乐
        <span className={styles.bgmCount}>{tracks.length} 首</span>
      </h4>

      <select
        className={styles.bgmSelect}
        value={selectedTrackId}
        disabled={disabled}
        onChange={(event) => chooseTrack(event.target.value)}
        aria-label="BGM 曲目"
        title={selectedTrackName || '无 BGM'}
      >
        <option value="">无 BGM</option>
        {tracks.map((track) => (
          <option key={track.id} value={track.id}>
            {track.filename}
          </option>
        ))}
      </select>

      <div className={styles.bgmActions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.small} ${styles.bgmAddButton}`}
          disabled={disabled || importing}
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" size={13} />
          {importing ? '添加中…' : '添加音乐'}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.small} ${styles.bgmAuditionButton} ${auditioning ? styles.bgmAuditionActive : ''}`}
          disabled={disabled || !selectedTrackId || importing}
          onClick={() => void toggleAudition()}
          aria-pressed={auditioning}
        >
          <Icon name={auditioning ? 'stop' : 'play'} size={12} />
          {auditioning ? '停止' : '试听'}
        </button>
        <input
          ref={inputRef}
          className={styles.bgmFileInput}
          type="file"
          accept={ACCEPTED_AUDIO}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void chooseFiles(event)}
        />
      </div>

      <div aria-live="polite">
        {status ? (
          <p className={styles.bgmImportStatus}>
            <span className={styles.bgmStatusDot} />
            {status}
          </p>
        ) : null}
      </div>

      <div className={styles.bgmControls}>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLab}>音量</span>
          <input
            type="range"
            min={-40}
            max={0}
            step={1}
            value={bgmGainDraft}
            disabled={disabled}
            onChange={(event) => previewBgmGain(Number(event.currentTarget.value))}
            onPointerUp={(event) => {
              if (bgmGainPendingRef.current !== null) commitBgmGain(Number(event.currentTarget.value));
            }}
            onPointerCancel={() => {
              if (bgmGainPendingRef.current !== null) commitBgmGain(bgmGainPendingRef.current);
            }}
            onKeyUp={() => {
              if (bgmGainPendingRef.current !== null) commitBgmGain(bgmGainPendingRef.current);
            }}
            onBlur={() => {
              if (bgmGainPendingRef.current !== null) commitBgmGain(bgmGainPendingRef.current);
            }}
            aria-label="音量（dB）"
          />
          <span className={styles.ctlVal}>{bgmGainDraft} dB</span>
        </div>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLab}>淡入</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            defaultValue={bgm.fadeInSec}
            key={`fade-in-${revision}`}
            disabled={disabled}
            onChange={(event) => void onCommand({
              type: 'set_bgm_fades',
              fadeInSec: Number(event.target.value),
              fadeOutSec: bgm.fadeOutSec,
            })}
            aria-label="淡入（秒）"
          />
          <span className={styles.ctlVal}>{bgm.fadeInSec}s</span>
        </div>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLab}>淡出</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            defaultValue={bgm.fadeOutSec}
            key={`fade-out-${revision}`}
            disabled={disabled}
            onChange={(event) => void onCommand({
              type: 'set_bgm_fades',
              fadeInSec: bgm.fadeInSec,
              fadeOutSec: Number(event.target.value),
            })}
            aria-label="淡出（秒）"
          />
          <span className={styles.ctlVal}>{bgm.fadeOutSec}s</span>
        </div>
      </div>

      <audio
        ref={audioRef}
        src={selectedTrackId
          ? `/api/final-edit-bgm/${encodeURIComponent(selectedTrackId)}/file`
          : undefined}
        preload="metadata"
        onEnded={() => setAuditioning(false)}
        onPause={() => setAuditioning(false)}
      />
    </section>
  );
}
