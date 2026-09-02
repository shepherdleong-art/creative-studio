'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { getCachedFontOptions, requestFontOptions } from '@/components/system-fonts';
import { drawFramedImage } from '@/lib/final-edit/cover-framing';
import { OUTPUT_PRESETS, type CoverEditorDraft, type CoverPresetV2, type FinalEditGroupView, type FinalEditVariantView, type OutputPresetId, type TextStyle } from '@/lib/final-edit/types';
import { drawText, fitTextStyleToSingleLine, horizontalTextBounds, isTextStyleWithinSafeArea, measureSingleLineText, textStyleFont } from '@/components/final-edit/text-canvas-renderer';
import styles from './mixcut-content.module.css';

interface CoverPresetView extends CoverPresetV2 {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

function cloneDraft(group: FinalEditGroupView, variant: FinalEditVariantView): CoverEditorDraft {
  const selectedSource = group.assets.find((asset) => asset.analysisStatus === 'succeeded' && ((asset.assetKey || asset.videoJobId) === variant.cover.sourceKey || asset.videoJobId === variant.cover.sourceKey));
  const fallbackSource = group.assets.find((asset) => asset.analysisStatus === 'succeeded');
  const sourceKey = selectedSource ? variant.cover.sourceKey! : fallbackSource?.assetKey || fallbackSource?.videoJobId || '';
  return {
    sourceKey,
    frameTimeUs: selectedSource ? variant.cover.frameTimeUs || 0 : 0,
    framing: { ...variant.cover.framing },
    primary: { text: group.coverTitle.primary.text, style: structuredClone(group.textStyles[variant.outputPreset].coverPrimary) },
    secondary: { text: group.coverTitle.secondary.text, style: structuredClone(group.textStyles[variant.outputPreset].coverSecondary) },
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

export function CoverEditorDrawer({ active, group, variant, busy, onClose, onApply }: {
  active: boolean;
  group: FinalEditGroupView;
  variant: FinalEditVariantView;
  busy: boolean;
  onClose: () => void;
  onApply: (draft: CoverEditorDraft) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CoverEditorDraft>(() => cloneDraft(group, variant));
  const [fonts, setFonts] = useState<string[]>(() => getCachedFontOptions() ?? ['PingFang SC']);
  const [presets, setPresets] = useState<CoverPresetView[]>([]);
  const [presetName, setPresetName] = useState('');
  const [message, setMessage] = useState('抽屉内修改尚未应用');
  const [overflow, setOverflow] = useState({ primary: false, secondary: false });
  const [loadedFrame, setLoadedFrame] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const output = OUTPUT_PRESETS[variant.outputPreset];
  const coverAssets = group.assets.filter((asset) => asset.analysisStatus === 'succeeded');
  const source = coverAssets.find((asset) => (asset.assetKey || asset.videoJobId) === draft.sourceKey || asset.videoJobId === draft.sourceKey) || coverAssets[0] || null;
  const frameUrl = source ? `/api/final-edit-groups/${group.id}/cover-frame?sourceKey=${encodeURIComponent(draft.sourceKey)}&timeUs=${draft.frameTimeUs}&preset=${variant.outputPreset}` : '';
  const frameReady = loadedFrame?.url === frameUrl;

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const refreshFonts = async () => {
    try {
      setFonts(await requestFontOptions(true));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void Promise.all([
      requestFontOptions().then(setFonts),
      fetch('/api/final-edit/title-presets').then((response) => readJson<CoverPresetView[]>(response)).then((presetBody) => setPresets(presetBody)),
    ]).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!active) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', keydown);
      previousFocusRef.current?.focus();
    };
  }, [active]);

  useEffect(() => {
    if (active && busy) dialogRef.current?.focus();
  }, [active, busy]);

  useEffect(() => {
    if (!frameUrl) return;
    const controller = new AbortController();
    let objectUrl = '';
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch(frameUrl, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          const image = new Image();
          image.onload = () => {
            if (!cancelled) {
              setLoadedFrame({ url: frameUrl, image });
              setMessage('抽屉内修改尚未应用');
            }
            URL.revokeObjectURL(objectUrl);
            objectUrl = '';
          };
          image.onerror = () => { if (!cancelled) setMessage('真实截帧读取失败，请调整时间或更换来源'); };
          image.src = objectUrl;
        })
        .catch((error) => {
          if (!cancelled && error instanceof Error && error.name !== 'AbortError') setMessage('真实截帧读取失败，请调整时间或更换来源');
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frameUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!loadedFrame || loadedFrame.url !== frameUrl) return;
    let cancelled = false;
    void Promise.all([
      document.fonts.load(textStyleFont(draft.primary.style), draft.primary.text),
      document.fonts.load(textStyleFont(draft.secondary.style), draft.secondary.text),
    ]).catch(() => undefined).then(() => {
      if (cancelled) return;
      drawFramedImage(context, loadedFrame.image, draft.framing);
      drawText(context, draft.primary.text, draft.primary.style);
      drawText(context, draft.secondary.text, draft.secondary.style);
    });
    return () => { cancelled = true; };
  }, [draft, frameUrl, loadedFrame, output.height, output.width]);

  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    void Promise.all([
      document.fonts.load(textStyleFont(draft.primary.style), draft.primary.text),
      document.fonts.load(textStyleFont(draft.secondary.style), draft.secondary.text),
    ]).catch(() => undefined).then(() => {
      frame = window.requestAnimationFrame(() => {
        const context = canvasRef.current?.getContext('2d');
        if (!context || cancelled) return;
        setOverflow({
          primary: !isTextStyleWithinSafeArea(context, draft.primary.text, draft.primary.style),
          secondary: !isTextStyleWithinSafeArea(context, draft.secondary.text, draft.secondary.style),
        });
      });
    });
    return () => { cancelled = true; if (frame) window.cancelAnimationFrame(frame); };
  }, [draft]);

  const patchPart = (part: 'primary' | 'secondary', patch: Partial<CoverEditorDraft['primary']>) => setDraft((current) => ({ ...current, [part]: { ...current[part], ...patch } }));
  const patchStyle = (part: 'primary' | 'secondary', patch: Partial<TextStyle>) => setDraft((current) => ({ ...current, [part]: { ...current[part], style: { ...current[part].style, ...patch } } }));
  const patchFraming = (patch: Partial<CoverEditorDraft['framing']>) => setDraft((current) => ({ ...current, framing: { ...current.framing, ...patch } }));

  const textTargetAtPoint = (clientX: number, clientY: number): 'primary' | 'secondary' | null => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width) * canvas.width;
    const y = (clientY - rect.top) / Math.max(1, rect.height) * canvas.height;
    const hits = (['primary', 'secondary'] as const).flatMap((part) => {
      const value = draft[part];
      const style = value.style;
      const width = measureSingleLineText(context, value.text, style);
      const { left, right } = horizontalTextBounds(canvas.width, width, style);
      const padding = Math.max(14, style.fontSizePx * style.scale * 0.2);
      const halfHeight = style.fontSizePx * style.scale * 0.65 + (style.stroke.enabled ? style.stroke.widthPx : 0);
      const centerY = style.y * canvas.height;
      return x >= left - padding && x <= right + padding && y >= centerY - halfHeight - padding && y <= centerY + halfHeight + padding
        ? [{ part, distance: Math.abs(y - centerY) }]
        : [];
    });
    hits.sort((left, right) => left.distance - right.distance);
    return hits[0]?.part || null;
  };

  const beginCanvasDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    const dragTarget = textTargetAtPoint(event.clientX, event.clientY);
    if (!dragTarget) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.style.cursor = 'grabbing';
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = structuredClone(draft);
    const move = (pointer: PointerEvent) => {
      const rect = target.getBoundingClientRect();
      const dx = (pointer.clientX - startX) / Math.max(1, rect.width);
      const dy = (pointer.clientY - startY) / Math.max(1, rect.height);
      setDraft({ ...initial, [dragTarget]: { ...initial[dragTarget], style: { ...initial[dragTarget].style, x: Math.max(0.04, Math.min(0.96, initial[dragTarget].style.x + dx)), y: Math.max(0.04, Math.min(0.96, initial[dragTarget].style.y + dy)) } } });
    };
    const up = (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.style.cursor = textTargetAtPoint(pointer.clientX, pointer.clientY) ? 'grab' : 'default';
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };

  const fitPart = (part: 'primary' | 'secondary') => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    patchStyle(part, fitTextStyleToSingleLine(context, draft[part].text, draft[part].style));
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) { setMessage('请先输入预设名称'); return; }
    const stylesByPreset = Object.fromEntries((Object.keys(OUTPUT_PRESETS) as OutputPresetId[]).map((preset) => [preset, {
      primary: preset === variant.outputPreset ? draft.primary.style : group.textStyles[preset].coverPrimary,
      secondary: preset === variant.outputPreset ? draft.secondary.style : group.textStyles[preset].coverSecondary,
      framing: preset === variant.outputPreset ? { ...draft.framing } : { scale: 1, offsetX: 0, offsetY: 0 },
    }])) as CoverPresetV2['stylesByPreset'];
    try {
      const created = await readJson<CoverPresetView>(await fetch('/api/final-edit/title-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version: 2, stylesByPreset }) }));
      setPresets((items) => [created, ...items]);
      setPresetName('');
      setMessage(`已保存预设「${name}」`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const applyPreset = (preset: CoverPresetView) => {
    const value = preset.stylesByPreset[variant.outputPreset];
    setDraft((current) => ({ ...current, framing: { ...value.framing }, primary: { ...current.primary, style: structuredClone(value.primary) }, secondary: { ...current.secondary, style: structuredClone(value.secondary) } }));
    setMessage(`已在本地应用预设「${preset.name}」，点击应用封面后才会保存`);
  };

  const deletePreset = async (preset: CoverPresetView) => {
    const response = await fetch(`/api/final-edit/title-presets/${preset.id}`, { method: 'DELETE' });
    if (response.ok) setPresets((items) => items.filter((item) => item.id !== preset.id));
    else setMessage((await response.json().catch(() => ({}))).message || '删除预设失败');
  };

  if (!active || typeof document === 'undefined') return null;
  return createPortal(
    <div className={styles.coverDrawerBackdrop} data-testid="cover-drawer-backdrop" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={styles.coverDrawer} role="dialog" aria-modal="true" aria-labelledby="cover-editor-title" aria-busy={busy} tabIndex={-1}>
        <header className={styles.coverDrawerHeader}>
          <div><p className={styles.eyebrow}>WYSIWYG COVER</p><h2 id="cover-editor-title">精调封面</h2><span>{variant.outputPreset.replace('x', ':')} · 真实视频帧</span></div>
          <button ref={closeButtonRef} type="button" aria-label="关闭封面精调" disabled={busy} onClick={onClose}><Icon name="close" size={18} /></button>
        </header>
        <fieldset className={styles.coverDrawerBody} disabled={busy}>
          <aside className={styles.coverSourcePanel}>
            <h3>来源片段</h3>
            <div className={styles.coverSourceList}>{coverAssets.map((asset) => {
              const key = asset.assetKey || asset.videoJobId;
              return <button type="button" key={key} className={key === draft.sourceKey ? styles.coverSourceSelected : ''} onClick={() => setDraft((current) => ({ ...current, sourceKey: key, frameTimeUs: 0 }))}><img src={asset.thumbnailUrl} alt="" /><span><strong>{asset.displayName || asset.filename}</strong><small>{(asset.durationUs / 1_000_000).toFixed(2)}s</small></span></button>;
            })}</div>
            <label className={styles.fieldLabel}>截帧时间 {(draft.frameTimeUs / 1_000_000).toFixed(2)}s<input aria-label="封面截帧时间" type="range" min={0} max={Math.max(0, (source?.durationUs || 0) / 1_000_000)} step={1 / 24} value={draft.frameTimeUs / 1_000_000} onChange={(event) => setDraft((current) => ({ ...current, frameTimeUs: Math.round(Number(event.target.value) * 1_000_000) }))} /></label>
          </aside>
          <main className={styles.coverCanvasPanel}>
            <div className={styles.coverCanvasWrap} data-output-preset={variant.outputPreset}>
              <canvas
                ref={canvasRef}
                aria-label="拖动主标题或副标题"
                onPointerDown={beginCanvasDrag}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.style.cursor = textTargetAtPoint(event.clientX, event.clientY) ? 'grab' : 'default';
                }}
                onPointerLeave={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.style.cursor = 'default'; }}
                style={{ pointerEvents: busy ? 'none' : undefined }}
              />
              <div className={styles.coverSafeArea} aria-label="4% 导出安全区" />
            </div>
            <p>直接拖动主标题或副标题定位；画面缩放与位置请使用右侧滑杆。虚线框为四边 4% 导出安全区。</p>
          </main>
          <aside className={styles.coverControlsPanel}>
            <section><h3>画面</h3><Range label="缩放" value={draft.framing.scale} min={1} max={3} step={0.05} onChange={(scale) => patchFraming({ scale })} /><Range label="水平" value={draft.framing.offsetX} min={-1} max={1} step={0.02} onChange={(offsetX) => patchFraming({ offsetX })} /><Range label="垂直" value={draft.framing.offsetY} min={-1} max={1} step={0.02} onChange={(offsetY) => patchFraming({ offsetY })} /></section>
            <section><div className={styles.coverControlHeading}><h3>共享字体</h3><button type="button" className={styles.coverRefreshButton} onClick={() => void refreshFonts()}>刷新字体</button></div><select aria-label="封面共享字体" value={draft.primary.style.fontFamily} onChange={(event) => { patchStyle('primary', { fontFamily: event.target.value, fontPostscriptName: undefined }); patchStyle('secondary', { fontFamily: event.target.value, fontPostscriptName: undefined }); }}>{fonts.map((font) => <option key={font}>{font}</option>)}</select></section>
            {(['primary', 'secondary'] as const).map((part) => <section key={part} className={overflow[part] ? styles.coverTextOverflow : ''}><div className={styles.coverControlHeading}><h3>{part === 'primary' ? '主标题' : '副标题'}</h3>{overflow[part] && <button type="button" onClick={() => fitPart(part)}>适配单行</button>}</div><input aria-label={`${part === 'primary' ? '主' : '副'}标题文字`} value={draft[part].text} onChange={(event) => patchPart(part, { text: event.target.value.replace(/[\r\n]+/g, '') })} /><div className={styles.coverInlineControls}><label>颜色<input type="color" value={draft[part].style.color} onChange={(event) => patchStyle(part, { color: event.target.value })} /></label><label>字号<input type="number" min={12} max={180} value={draft[part].style.fontSizePx} onChange={(event) => patchStyle(part, { fontSizePx: Number(event.target.value) })} /></label></div><label className={styles.coverCheck}><input type="checkbox" checked={draft[part].style.italic} onChange={(event) => patchStyle(part, { italic: event.target.checked })} />斜体</label><label className={styles.coverCheck}><input type="checkbox" checked={draft[part].style.stroke.enabled} onChange={(event) => patchStyle(part, { stroke: { ...draft[part].style.stroke, enabled: event.target.checked } })} />描边</label><div className={styles.coverInlineControls}><label>描边色<input type="color" value={draft[part].style.stroke.color} onChange={(event) => patchStyle(part, { stroke: { ...draft[part].style.stroke, color: event.target.value } })} /></label><label>粗细<input type="number" min={0} max={16} step={0.5} value={draft[part].style.stroke.widthPx} onChange={(event) => patchStyle(part, { stroke: { ...draft[part].style.stroke, widthPx: Number(event.target.value) } })} /></label></div></section>)}
            <section><h3>内置样式</h3><button type="button" className={styles.coverPresetButton} onClick={() => { patchStyle('primary', { color: '#ffffff', italic: false, stroke: { enabled: true, color: '#101010', widthPx: 4 } }); patchStyle('secondary', { color: '#61a8ff', italic: true, stroke: { enabled: true, color: '#0b1d35', widthPx: 2 } }); }}>清爽蓝白</button></section>
            <section><h3>自定义预设</h3><div className={styles.coverPresetSave}><input aria-label="预设名称" placeholder="输入名称" value={presetName} onChange={(event) => setPresetName(event.target.value)} /><button type="button" onClick={() => void savePreset()}>保存</button></div>{presets.map((preset) => <div key={preset.id} className={styles.coverPresetRow}><button type="button" onClick={() => applyPreset(preset)}>{preset.name}</button><button type="button" aria-label={`删除预设 ${preset.name}`} onClick={() => void deletePreset(preset)}>删除</button></div>)}</section>
          </aside>
        </fieldset>
        <footer className={styles.coverDrawerFooter}><span aria-live="polite">{frameReady ? message : '正在读取真实视频帧…'}</span><div><button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button><button type="button" className={styles.primaryButton} disabled={busy || !source || !frameReady || overflow.primary || overflow.secondary} onClick={() => void onApply(draft).then((accepted) => { if (accepted) onClose(); })}>{busy ? '正在应用…' : '应用封面'}</button></div></footer>
      </section>
    </div>,
    document.body,
  );
}

function Range({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className={styles.coverRange}><span>{label}<output>{value.toFixed(2)}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
