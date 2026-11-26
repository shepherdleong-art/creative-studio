'use client';

import type { FilmAutoCoverFallback, FilmAutoCoverState } from '@/lib/one-click-film/cover-auto-state';
import styles from './one-click-film.module.css';

const fallbackText: Record<FilmAutoCoverFallback, string> = {
  no_provider: '视觉模型未配置',
  no_panorama: '未找到清晰的产品全景',
  invalid_result: '视觉模型未返回可用候选',
  content_filtered: '视觉服务内容审核未通过',
  timeout: '视觉模型响应超时',
  media_unavailable: '候选画面暂不可用',
  request_failed: '视觉服务暂不可用',
};

export function FilmCoverAutoControls({ state, current, disabled, onRetry }: {
  state?: FilmAutoCoverState;
  current: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (!state) return null;
  return <>
    <div className={styles.inlineActions}>
      <button type="button" className="cap" disabled={disabled || state.status === 'pending'} onClick={onRetry}>重新自动挑选</button>
    </div>
    {state.status === 'pending' ? <p className={styles.hint} role="status">正在自动挑选产品全景帧…</p>
      : state.reason ? <p className={styles.hint} role="status">{fallbackText[state.reason]}{current ? '，使用正文首帧。' : '。'}</p> : null}
  </>;
}
