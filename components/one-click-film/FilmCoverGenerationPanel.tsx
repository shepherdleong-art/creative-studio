'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FILM_COVER_TITLE_CLEARANCE, MAX_FILM_COVER_PREFERENCE_LENGTH, MAX_FILM_COVER_REFERENCES,
  type FilmCoverCandidate, type FilmCoverGenerationConfig } from '@/lib/one-click-film/cover-generation-types';
import type { FilmCoverMedia } from '@/lib/one-click-film/cover-media';
import type { OneClickFilmTemplateId } from '@/lib/one-click-film/packaging-constants';
import { SCENE_USAGE, type FilmImage } from './types';
import styles from './one-click-film.module.css';

export function FilmCoverGenerationPanel({ projectId, entryCode, template, images, cover, busy, onSelect }: {
  projectId: string;
  entryCode: string;
  template: OneClickFilmTemplateId;
  images: FilmImage[];
  cover: FilmCoverMedia;
  busy: boolean;
  onSelect: (media: FilmCoverMedia) => void;
}) {
  const endpoint = `/api/one-click-film/${encodeURIComponent(projectId)}/packaging`;
  const [config, setConfig] = useState<FilmCoverGenerationConfig>();
  const [candidates, setCandidates] = useState<FilmCoverCandidate[]>([]);
  const [references, setReferences] = useState(() => images.filter(image => image.usage === SCENE_USAGE)
    .slice(0, MAX_FILM_COVER_REFERENCES).map(image => image.id));
  const [providerId, setProviderId] = useState('');
  const [preference, setPreference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ key: string; intent: string } | null>(null);
  const inFlight = useRef(false);
  const pending = candidates.some(candidate => candidate.status === 'queued' || candidate.status === 'running');
  const generating = candidates.some(candidate => candidate.status === 'queued' || (candidate.status === 'running' && !candidate.submissionUnconfirmed));
  const lastUnconfirmed = candidates.at(-1)?.submissionUnconfirmed;
  const maxReferences = config?.maxReferences ?? MAX_FILM_COVER_REFERENCES;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${endpoint}?coverCandidates=${encodeURIComponent(entryCode)}`, { signal, cache: 'no-store' });
      const payload = await response.json() as { coverGeneration?: FilmCoverGenerationConfig; coverCandidates?: FilmCoverCandidate[]; message?: string };
      if (!response.ok || !payload.coverGeneration || !payload.coverCandidates) throw new Error(payload.message || '暂时无法读取全景封面候选。');
      if (signal?.aborted) return;
      setConfig(payload.coverGeneration);
      setCandidates(payload.coverCandidates);
      setProviderId(previous => payload.coverGeneration!.channels.some(channel => channel.id === previous)
        ? previous : payload.coverGeneration!.channels[0]?.id ?? '');
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '暂时无法读取全景封面候选。');
    }
  }, [endpoint, entryCode]);

  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => { void refresh(abort.signal); }, 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (!pending) return;
    const abort = new AbortController();
    const timer = setInterval(() => { void refresh(abort.signal); }, 3500);
    return () => { clearInterval(timer); abort.abort(); };
  }, [pending, refresh]);

  async function generate() {
    if (inFlight.current || !config?.enabled || !providerId) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    const input = { action: 'generate-cover', entryCode, providerId, referenceImageIds: references, preference, template };
    const intent = JSON.stringify(input);
    if (request.current?.intent !== intent) request.current = { key: crypto.randomUUID(), intent };
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, requestKey: request.current.key }) });
      const payload = await response.json() as { coverCandidate?: FilmCoverCandidate; message?: string };
      if (!response.ok || !payload.coverCandidate) throw new Error(payload.message || '暂时无法提交全景封面。');
      const candidate = payload.coverCandidate;
      request.current = null;
      setCandidates(current => [...current.filter(item => item.id !== candidate.id), candidate]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法提交全景封面。');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return <div className={styles.filmCoverPanelContent} role="tabpanel" aria-label="AI 生成全景">
    {config?.reason ? <p className={styles.hint} role="status">{config.reason}</p> : null}
    <p className={styles.hint}>{FILM_COVER_TITLE_CLEARANCE[template]}</p>
    {images.length > 0 ? <fieldset className={styles.filmCoverReferences}>
      <legend className={styles.hint}>项目参考图（<span className="tnum">{references.length}/{maxReferences}</span>）</legend>
      {images.map(image => <label key={image.id} title={image.filename} className={styles.filmCoverReference}>
        <input type="checkbox" checked={references.includes(image.id)}
          disabled={submitting || (!references.includes(image.id) && references.length >= maxReferences)}
          onChange={event => setReferences(current => event.target.checked ? [...current, image.id] : current.filter(id => id !== image.id))} />
        {/* eslint-disable-next-line @next/next/no-img-element -- 只读取已授权的项目缩略图 */}
        <img src={`${endpoint}?coverThumbnail=${encodeURIComponent(image.id)}`} alt="" loading="lazy" />
        <span className={styles.filmCoverFilename}>{image.filename}</span>
      </label>)}
    </fieldset> : null}
    <label className={styles.editRow}>生成通道
      <select className="input-field" value={providerId} disabled={!config?.enabled || submitting}
        onChange={event => setProviderId(event.target.value)}>
        {config?.channels.length ? config.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)
          : <option value="">无可用通道</option>}
      </select>
    </label>
    <label className={styles.editRow}>构图偏好
      <input className="input-field" type="text" placeholder="选填" maxLength={MAX_FILM_COVER_PREFERENCE_LENGTH}
        value={preference} disabled={submitting} onChange={event => setPreference(event.target.value)} />
    </label>
    <div className={styles.inlineActions}>
      <button type="button" className="cap" disabled={busy || generating || submitting || !config?.enabled || !providerId}
        onClick={() => { void generate(); }}>{submitting ? '正在提交' : lastUnconfirmed ? '另生成一张（单独计费）' : '生成全景封面'}</button>
    </div>
    {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    {candidates.length ? <div className={styles.filmCoverShots} role="group" aria-label="全景封面候选">
      {candidates.map((candidate, index) => candidate.status === 'ready' && candidate.thumbnailUrl ?
        <button type="button" key={candidate.id} className={styles.filmCoverShot} aria-label={`采用 AI 封面 ${index + 1}`}
          disabled={busy} aria-pressed={cover.kind === 'generated_image' && cover.assetId === candidate.id}
          onClick={() => onSelect({ kind: 'generated_image', assetId: candidate.id,
            framing: cover.kind === 'generated_image' && cover.assetId === candidate.id ? cover.framing : undefined })}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 受权候选缩略图 */}
          <img src={candidate.thumbnailUrl} alt="" loading="lazy" />
          <span className="tnum">{index + 1} · {candidate.channel}</span>
        </button> : <div key={candidate.id} className={styles.filmCoverShot} role="status">
          <span className="tnum">{index + 1} · {candidate.channel}</span>
          <span className={candidate.status === 'failed' ? styles.hintFail : styles.hint}>{candidate.message}</span>
        </div>)}
    </div> : null}
  </div>;
}
