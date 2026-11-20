'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { ToolbarButton } from '@/components/ui/Appearance';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import styles from './one-click-film.module.css';

const seconds = (frame: number) => frame / FINAL_EDIT_FPS;

export function CandidateTrimDialog({ url, initialFrame, length, totalFrames, adopted, working, error, onClose, onReplace }: {
  url: string;
  initialFrame: number;
  length: number;
  totalFrames: number;
  adopted: boolean;
  working: boolean;
  error: string;
  onClose: () => void;
  onReplace: (frame: number) => void;
}) {
  const [start, setStart] = useState(initialFrame);
  const [playing, setPlaying] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const end = start + length;
  const display = (frame: number) => `${seconds(frame).toFixed(2)} 秒`;
  const stop = () => {
    video.current?.pause();
    setPlaying(false);
  };

  useEffect(() => {
    if (!playing) return;
    let request = 0;
    const loop = () => {
      const element = video.current;
      if (!element) return;
      if (element.currentTime >= seconds(end) || element.ended) {
        element.currentTime = seconds(start);
        if (element.paused) void element.play().catch(() => setPlaying(false));
      }
      request = requestAnimationFrame(loop);
    };
    request = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(request);
  }, [end, playing, start]);

  const move = (edge: 'in' | 'out', frame: number) => {
    const next = Math.max(0, Math.min(totalFrames - length, edge === 'in' ? frame : frame - length));
    stop();
    setStart(next);
    if (video.current?.readyState) video.current.currentTime = seconds(edge === 'in' ? next : next + length - 1);
  };

  return <Dialog open width="wide" title="调整候选片段" onClose={onClose}
    description={`选区固定为 ${display(length)}。拖动入点看首帧，拖动出点看末帧。`}
    footer={<div className={styles.inlineActions}>
      <ToolbarButton disabled={working} onClick={onClose}>取消</ToolbarButton>
      <ToolbarButton variant="primary" disabled={working || (adopted && start === initialFrame)} onClick={() => { stop(); onReplace(start); }}>
        {working ? '正在替换…' : '替换'}
      </ToolbarButton>
    </div>}>
    <div className={styles.candidateTrim}>
      <div className={styles.trimMonitor}>
        <video ref={video} src={url} aria-label="候选剪裁预览" muted playsInline preload="auto"
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = seconds(start); }}
          onError={() => setMediaError(true)} />
      </div>
      {mediaError ? <p className={styles.hintFail} role="alert">候选视频预览加载失败。</p> : null}
      <div className={styles.trimReadout}>
        <span>入点 <b className="tnum">{display(start)}</b></span>
        <span>出点 <b className="tnum">{display(end)}</b></span>
      </div>
      <div className={styles.trimRail}>
        <div className={styles.trimSelection} style={{ left: `${start / totalFrames * 100}%`, width: `${length / totalFrames * 100}%` }} />
        <input type="range" aria-label="候选入点" aria-valuetext={display(start)} min={0} max={totalFrames} value={start}
          disabled={working || totalFrames === length} onChange={(event) => move('in', Number(event.currentTarget.value))} />
        <input type="range" aria-label="候选出点" aria-valuetext={display(end)} min={0} max={totalFrames} value={end}
          disabled={working || totalFrames === length} onChange={(event) => move('out', Number(event.currentTarget.value))} />
      </div>
      <div className={styles.trimReadout}>
        <span className="tnum">0.00 秒</span>
        <span className="tnum">{display(totalFrames)}</span>
      </div>
      <div className={styles.inlineActions}>
        <ToolbarButton disabled={working || mediaError} onClick={() => {
          if (playing) { stop(); return; }
          const element = video.current;
          if (!element) return;
          element.currentTime = seconds(start);
          void element.play().then(() => setPlaying(true)).catch(() => setMediaError(true));
        }}>{playing ? '暂停' : '循环预览选区'}</ToolbarButton>
      </div>
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </div>
  </Dialog>;
}
