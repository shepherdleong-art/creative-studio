'use client';

import { useCallback, useEffect, useState } from 'react';
import { GroupHeading, Tag } from '@/components/ui/Appearance';
import styles from './one-click-film.module.css';

interface Narration {
  id: string;
  entryCode: string;
  durationUs: number;
  status: string;
  listened: boolean;
  confirmed: boolean;
  url: string | null;
  current: boolean;
  errorMessage: string | null;
}

interface TtsProvider {
  id: string;
  name: string;
  voices: Array<{ id: string; label: string }>;
  defaultVoice: string;
}

/**
 * TTS 试听与确认：只有播放过当前版本的配音才能确认；
 * 超过正文时长时明确提示改文案、调语速或选更长正文。
 */
export function NarrationPanel({ projectId, bodyDurationSec }: { projectId: string; bodyDurationSec: number }) {
  const [providers, setProviders] = useState<TtsProvider[]>([]);
  const [narrations, setNarrations] = useState<Narration[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/narration`, { cache: 'no-store' });
      const body = await response.json() as {
        providers?: TtsProvider[]; narrations?: Narration[]; message?: string; error?: string;
      };
      if (!response.ok) throw new Error(body.message || body.error || '读取配音失败');
      setProviders(body.providers ?? []);
      setNarrations(body.narrations ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/narration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return <div className={styles.narrationPanel}>
    <GroupHeading action={<small className={styles.hint}>{providers.length} 个配音服务</small>}>TTS 配音</GroupHeading>
    <button type="button" className="cap" disabled={working} onClick={() => void post({ action: 'synthesize' })}>
      {working ? '生成中…' : '为整批生成配音'}
    </button>
    {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    {narrations.length === 0
      ? <p className={styles.hint}>还没有配音。生成后逐条试听并确认。</p>
      : <div className={styles.narrationList}>
        {narrations.map((narration) => {
          const tooLong = narration.durationUs > bodyDurationSec * 1_000_000;
          return <div key={narration.id} className={styles.narrationItem}>
            <div className={styles.narrationHead}>
              <b>{narration.entryCode}</b>
              <Tag tone={narration.confirmed ? 'ok' : narration.status === 'failed' ? 'fail' : 'warn'}>
                {narration.confirmed ? '已确认' : narration.status === 'ready' ? '待确认' : narration.status === 'failed' ? '失败' : '生成中'}
              </Tag>
              {narration.current ? null : <Tag tone="idle">旧版本</Tag>}
              <small>{(narration.durationUs / 1e6).toFixed(1)} 秒</small>
            </div>
            {narration.url ? <audio
              className={styles.narrationAudio}
              src={narration.url}
              controls
              onPlay={() => { if (!narration.listened) void post({ action: 'listened', narrationId: narration.id }); }}
            /> : null}
            {tooLong ? <p className={styles.hintFail}>
              配音超过正文 {bodyDurationSec} 秒，请改文案、调语速或选更长正文。
            </p> : null}
            {narration.errorMessage ? <p className={styles.hintFail}>{narration.errorMessage}</p> : null}
            <button
              type="button"
              className="cap"
              disabled={!narration.url || !narration.listened || narration.confirmed || working}
              onClick={() => void post({ action: 'confirm', narrationId: narration.id })}
            >
              {narration.listened ? '确认这条配音' : '先试听再确认'}
            </button>
          </div>;
        })}
      </div>}
  </div>;
}
