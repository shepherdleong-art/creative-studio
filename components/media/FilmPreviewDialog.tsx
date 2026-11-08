'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId } from '@/lib/final-edit/types';
import styles from './film-preview-dialog.module.css';

/**
 * 成片预览对话框（09 号票新建的共用件，11 号票复用）——**宽高按可用高度直接算**。
 *
 * 规格「导出预览与一键下载全部」：
 * - 成片是 3:4，宽高必须用容器可用高度**算出来**（`height` → `width = height * ratio`），
 *   不靠浏览器的 `aspect-ratio` 从宽度反推。原因：原型在 Safari 里被挤成一条细缝（第八轮）。
 * - 控件：播放暂停、可点可拖的进度条、时间。
 * - 空格播放暂停、Esc 关闭、左右键换条；**预览开着时方向键不翻页**（时间轴不许跟着动）。
 * - 播放**真实导出的成片，有声音**（`<video>` 不静音），旁边显示时长、画幅、包装、文件名。
 *
 * 11 号票的扩展点：`items` 传整批成片、`index` + `onIndexChange` 受控切换，
 * 左右键自动变成「上一条 / 下一条」；单条时左右键被本组件吞掉，不会传回时间轴。
 */
export interface FilmPreviewItem {
  id: string;
  /** 标题（脚本名 / 成片名）。 */
  title?: string;
  /** 成片视频地址（真实导出产物）。 */
  src: string;
  /** 封面或首帧（可缺省）。 */
  poster?: string;
  /** 画幅；缺省按 3:4。 */
  preset?: OutputPresetId;
  /** 时长（秒）；缺省时用视频元数据。 */
  durationSec?: number;
  /** 分辨率文本，例如 `1080×1440`。 */
  resolution?: string;
  /** 包装名称，例如模板名；缺省显示「未启用」。 */
  packaging?: string;
  /** 成片文件名。 */
  filename?: string;
  /** 状态或说明（「改过但还没重新导出」等）。 */
  status?: string;
  /** 额外说明，例如「播放的是上一版正式成片」。 */
  note?: ReactNode;
  downloadVideoUrl?: string;
  downloadCoverUrl?: string;
  coverDownloadUrl?: string;
}

/** 画幅 → 宽高比（宽 / 高）。只用于把高度换算成宽度。 */
const PRESET_RATIOS: Record<OutputPresetId, number> = {
  '3x4': 3 / 4,
  '9x16': 9 / 16,
  '16x9': 16 / 9,
};

const PRESET_RESOLUTIONS: Record<OutputPresetId, string> = {
  '3x4': '1080×1440',
  '9x16': '1080×1920',
  '16x9': '1920×1080',
};

const PRESET_LABELS: Record<OutputPresetId, string> = {
  '3x4': '3:4',
  '9x16': '9:16',
  '16x9': '16:9',
};

function formatTime(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function FilmPreviewDialog({
  open,
  items,
  index,
  defaultIndex = 0,
  onIndexChange,
  onClose,
  title = '成片预览',
  subtitle,
  actions,
  infoExtra,
}: {
  open: boolean;
  items: FilmPreviewItem[];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  /** 底栏额外操作（下载等）。11 号票「一键下载全部」可放这里。 */
  actions?: ReactNode;
  /** 信息栏追加行。 */
  infoExtra?: { label: string; value: ReactNode }[];
}) {
  const safeItems = useMemo(() => items.filter((item) => item?.src), [items]);
  const [innerIndex, setInnerIndex] = useState(defaultIndex);
  const activeIndex = Math.min(Math.max(index ?? innerIndex, 0), Math.max(0, safeItems.length - 1));
  const item = safeItems[activeIndex] ?? null;
  const preset: OutputPresetId = item?.preset ?? '3x4';
  const ratio = PRESET_RATIOS[preset] ?? 3 / 4;
  const navigable = safeItems.length > 1;

  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  const changeIndex = useCallback((next: number) => {
    if (!safeItems.length) return;
    const wrapped = (next + safeItems.length) % safeItems.length;
    // 换条：进度与播放状态在切换入口重置（不在 effect 里 setState，避免级联渲染告警）。
    videoRef.current?.pause();
    setCurrentSec(0);
    setPlaying(false);
    setDurationSec(safeItems[wrapped]?.durationSec ?? 0);
    if (index === undefined) setInnerIndex(wrapped);
    onIndexChange?.(wrapped);
  }, [index, onIndexChange, safeItems]);

  // ---- 宽高：**从容器可用高度算出来**，再显式写死 ----
  // 只有一份测量逻辑：ResizeObserver 感知容器变化，换条时容器高度也会跟着变，
  // 所以同时订阅 activeIndex（不用再写第二段同步 setState 的 effect，
  // 那样会触发 react-hooks「effect 里同步 setState」的级联渲染告警）。
  useEffect(() => {
    if (!open) return;
    const element = stageBoxRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const availableWidth = Math.max(0, rect.width);
      const availableHeight = Math.max(0, rect.height);
      if (availableWidth < 2 || availableHeight < 2) return;
      let height = availableHeight;
      let width = height * ratio;
      if (width > availableWidth) {
        width = availableWidth;
        height = width / ratio;
      }
      const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      setSize((current) => current && current.width === next.width && current.height === next.height ? current : next);
    };
    // 首帧同步量一次（effect 内同步 setState 这里只发生一次，且是量出来的值，
    // 不是从 props 复制的派生状态）；后续变化交给 ResizeObserver。
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open, ratio, activeIndex]);

  // 关闭时不留在后台出声：关闭走 close()（先 pause 再通知父级），
  // 而 open=false 时本组件直接 return null，<video> 随之卸载——不需要再用 effect 重置状态
  // （那会踩 react-hooks/set-state-in-effect 的级联渲染告警）。

  const close = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
    onClose();
  }, [onClose]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // 播放必须走用户手势（浏览器自动播放策略），这里由点击或空格触发。
      const started = video.play();
      if (started && typeof started.catch === 'function') started.catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, []);

  const seekToRatio = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationSec;
    if (!(duration > 0)) return;
    const clamped = Math.min(1, Math.max(0, value));
    try {
      video.currentTime = clamped * duration;
    } catch { /* 元数据还没就绪 */ }
    setCurrentSec(clamped * duration);
  }, [durationSec]);

  // ---- 键盘：空格播放暂停、Esc 关闭、左右键换条；方向键一律不传给页面 ----
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (key === ' ' || key === 'Spacebar') {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        togglePlayback();
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // 「预览开着时方向键不翻页」：先吞掉，批量模式下才作为换条。
        event.preventDefault();
        event.stopPropagation();
        if (!navigable) return;
        changeIndex(activeIndex + (key === 'ArrowRight' ? 1 : -1));
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [activeIndex, changeIndex, close, navigable, open, togglePlayback]);

  // 进度条：点一下跳过去，按住可以拖。
  const beginSeek = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = progressRef.current;
    if (!bar) return;
    event.preventDefault();
    const bounds = bar.getBoundingClientRect();
    const apply = (clientX: number) => seekToRatio((clientX - bounds.left) / Math.max(1, bounds.width));
    apply(event.clientX);
    const move = (pointer: PointerEvent) => apply(pointer.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!open || !item) return null;

  const totalSec = durationSec || item.durationSec || 0;
  const progress = totalSec > 0 ? Math.min(1, Math.max(0, currentSec / totalSec)) : 0;

  return (
    <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="film-preview-dialog"
      >
        <header className={styles.header}>
          <div className={styles.headerCopy}>
            <b>{item.title || title}</b>
            <small>{subtitle || (navigable ? `第 ${activeIndex + 1} 条，共 ${safeItems.length} 条` : '真实导出的成片，有声音')}</small>
          </div>
          {navigable ? (
            <div className={styles.nav}>
              <button type="button" className={styles.navButton} aria-label="上一条" onClick={() => changeIndex(activeIndex - 1)}>
                <Icon name="chevron-left" size={16} />
              </button>
              <span>{activeIndex + 1} / {safeItems.length}</span>
              <button type="button" className={styles.navButton} aria-label="下一条" onClick={() => changeIndex(activeIndex + 1)}>
                <Icon name="chevron-right" size={16} />
              </button>
            </div>
          ) : null}
          <button type="button" className={styles.closeButton} aria-label="关闭预览" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.left}>
            <div className={styles.stageBox} ref={stageBoxRef}>
              <div
                className={styles.stage}
                data-testid="film-preview-stage"
                data-media-frame=""
                data-preset={preset}
                style={size ? { width: size.width, height: size.height } : undefined}
              >
                <video
                  key={item.id}
                  ref={videoRef}
                  className={styles.video}
                  src={item.src}
                  poster={item.poster}
                  preload="metadata"
                  playsInline
                  aria-label={`成片预览：${item.title || item.filename || '成片'}`}
                  onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    setDurationSec(Number.isFinite(duration) && duration > 0 ? duration : (item.durationSec ?? 0));
                  }}
                  onTimeUpdate={(event) => setCurrentSec(event.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => { setPlaying(false); setCurrentSec(0); }}
                />
              </div>
            </div>

            <div
              className={styles.progress}
              ref={progressRef}
              role="slider"
              tabIndex={0}
              aria-label="预览进度"
              aria-valuemin={0}
              aria-valuemax={Math.round(totalSec * 10) / 10}
              aria-valuenow={Math.round(currentSec * 10) / 10}
              aria-valuetext={`${formatTime(currentSec)} / ${formatTime(totalSec)}`}
              onPointerDown={beginSeek}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  event.stopPropagation();
                  const step = event.shiftKey ? 10 : 1;
                  seekToRatio((currentSec + (event.key === 'ArrowRight' ? step : -step)) / Math.max(1, totalSec));
                }
              }}
            >
              <i style={{ width: `${progress * 100}%` }} />
            </div>

            <div className={styles.transport}>
              <button type="button" className={styles.playButton} aria-label={playing ? '暂停预览' : '播放预览'} onClick={togglePlayback}>
                <Icon name={playing ? 'pause' : 'play'} size={16} />
              </button>
              <span className={styles.timecode}>
                <span data-testid="film-preview-current">{formatTime(currentSec)}</span>
                <small> / {formatTime(totalSec)}</small>
              </span>
              <span className={styles.hint}>空格播放暂停 · Esc 关闭{navigable ? ' · 左右键换条' : ''}</span>
            </div>
          </div>

          <aside className={styles.side} aria-label="成片信息">
            <div className={styles.infoList}>
              <InfoRow label="时长" value={`${(item.durationSec ?? totalSec).toFixed(1)} 秒`} />
              <InfoRow label="画幅" value={`${PRESET_LABELS[preset]}，${item.resolution || PRESET_RESOLUTIONS[preset]}`} />
              <InfoRow label="包装" value={item.packaging || '未启用'} />
              <InfoRow label="文件名" value={item.filename || '—'} mono />
              {item.status ? <InfoRow label="状态" value={item.status} /> : null}
              {(infoExtra ?? []).map((row) => <InfoRow key={row.label} label={row.label} value={row.value} />)}
            </div>
            {item.note ? <p className={styles.note}>{item.note}</p> : null}
          </aside>
        </div>

        {(actions || item.downloadVideoUrl || item.downloadCoverUrl || item.coverDownloadUrl) ? (
          <footer className={styles.footer}>
            <span className={styles.footerSpacer} />
            {item.downloadVideoUrl ? <a className={styles.footerButton} href={item.downloadVideoUrl}><Icon name="download" size={15} />下载成片</a> : null}
            {item.downloadCoverUrl || item.coverDownloadUrl ? (
              <a className={styles.footerButton} href={item.downloadCoverUrl || item.coverDownloadUrl}><Icon name="image" size={15} />下载封面</a>
            ) : null}
            {actions}
            <button type="button" className={styles.primaryButton} onClick={close}>关闭</button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className={styles.infoRow}>
      <span>{label}</span>
      <span className={mono ? styles.mono : undefined} title={typeof value === 'string' ? value : undefined}>{value}</span>
    </div>
  );
}
