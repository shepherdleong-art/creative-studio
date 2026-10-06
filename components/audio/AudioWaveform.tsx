'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadWaveform } from './waveform-loader';
import { waveformBars, type WaveformData } from './waveform-data';
import styles from './audio-waveform.module.css';

export default function AudioWaveform({ url, sourceKey, sourceStartUs, sourceEndUs, widthPx, loop = false }: {
  url: string | null;
  sourceKey: string;
  sourceStartUs: number;
  sourceEndUs: number;
  widthPx: number;
  loop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ key: string; data: WaveformData | null } | null>(null);
  const key = `${url}\n${sourceKey}`;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '100px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!url || !visible) return;
    let cancelled = false;
    loadWaveform(url, sourceKey).then(data => {
      if (!cancelled) setResult({ key, data });
    }, () => {
      if (!cancelled) setResult({ key, data: null });
    });
    return () => { cancelled = true; };
  }, [url, sourceKey, key, visible]);
  const data = result?.key === key ? result.data : null;
  const count = Math.min(8192, Math.max(1, Math.floor(widthPx / 3)));
  const path = useMemo(() => {
    if (!data || !visible) return '';
    return waveformBars(data, sourceStartUs / 1e6, sourceEndUs / 1e6, count, loop).map((peak, index) => {
      const height = data.maxPeak > 0 ? peak / data.maxPeak * 19 : 0;
      const x = ((index + 0.5) * widthPx / count).toFixed(2);
      return `M${x},${(12 - height / 2).toFixed(2)}v${Math.max(0.6, height).toFixed(2)}`;
    }).join('');
  }, [data, visible, sourceStartUs, sourceEndUs, count, loop, widthPx]);
  const status = !url || (result?.key === key && !data) ? 'error' : data ? 'ready' : 'loading';
  return <div ref={ref} className={styles.waveform} data-waveform-status={status} data-source-start-us={sourceStartUs} data-source-end-us={sourceEndUs} aria-hidden="true">
    {data ? <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(1, widthPx)} 24`} preserveAspectRatio="none"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      : <span className={styles.status}>{status === 'loading' ? '读取波形…' : '波形暂不可用'}</span>}
  </div>;
}
