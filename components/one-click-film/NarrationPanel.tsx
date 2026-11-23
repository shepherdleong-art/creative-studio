'use client';

import { useCallback, useEffect, useState } from 'react';
import { GroupHeading, Tag } from '@/components/ui/Appearance';
import styles from './one-click-film.module.css';
import type { FilmEntry } from './types';

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
export function NarrationPanel({ projectId, bodyDurationSec, entries, onConfigured }: {
  projectId: string; bodyDurationSec: number; entries: FilmEntry[]; onConfigured: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<TtsProvider[]>([]);
  const [narrations, setNarrations] = useState<Narration[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [settings, setSettings] = useState(() => ({
    providerId: entries[0]?.ttsProviderId || '', voice: entries[0]?.ttsVoice || '', speed: entries[0]?.ttsSpeed || 1,
  }));
  const [configured, setConfigured] = useState('');

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
      const payload = await response.json() as { message?: string; error?: string; affected?: string[] };
      if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
      await load();
      if (payload.affected) {
        setConfigured(payload.affected.length ? `需要重新配音并确认：${payload.affected.join('、')}` : '配音设置已应用');
        await onConfigured();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return <div className={styles.narrationPanel}>
    <GroupHeading action={<small className={styles.hint}>{providers.length} 个配音服务</small>}>TTS 配音</GroupHeading>
    <label className={styles.editRow}>配音服务
      <select aria-label="配音服务" className="input-field" value={settings.providerId} onChange={(event) => {
        const provider = providers.find((item) => item.id === event.target.value);
        setSettings({ ...settings, providerId: provider?.id ?? '', voice: provider?.defaultVoice ?? '' });
      }}>
        <option value="">请选择</option>
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select>
    </label>
    <label className={styles.editRow}>音色
      <select aria-label="音色" className="input-field" value={settings.voice} onChange={(event) => setSettings({ ...settings, voice: event.target.value })}>
        {providers.find((provider) => provider.id === settings.providerId)?.voices.map((voice) =>
          <option key={voice.id} value={voice.id}>{voice.label}</option>)}
      </select>
    </label>
    <label className={styles.editRow}>语速
      <input aria-label="配音语速" className="input-field" type="number" step="0.05" min="0.5" max="2" value={settings.speed}
        onChange={(event) => setSettings({ ...settings, speed: Number(event.target.value) })} />
    </label>
    <button type="button" className="cap" disabled={working || !settings.providerId}
      onClick={() => void post({ action: 'configure', ...settings })}>应用配音设置</button>
    {configured ? <p className={styles.hint} role="status">{configured}</p> : null}
    <button type="button" className="cap" disabled={working} onClick={() => void post({ action: 'synthesize' })}>
      {working ? '生成中…' : '为整批生成配音'}
    </button>
    {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    {entries.map((entry) => <button key={entry.code} type="button" className="cap" disabled={working || !entry.ttsProviderId}
      onClick={() => void post({ action: 'synthesize', codes: [entry.code] })}>生成 {entry.code} 配音</button>)}
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
              disabled={!narration.url || !narration.listened || narration.confirmed || !narration.current || working}
              onClick={() => void post({ action: 'confirm', narrationId: narration.id })}
            >
              {narration.listened ? '确认这条配音' : '先试听再确认'}
            </button>
          </div>;
        })}
      </div>}
  </div>;
}
