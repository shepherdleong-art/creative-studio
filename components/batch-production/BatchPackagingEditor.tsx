'use client';

import { useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/batch-production/output-arrangement';
import type { FinalEditPackagingConfig } from '@/lib/media-core/packaging-vars';
import { FontPicker } from '@/components/mixcut/FontPicker';
import { TEMPLATES, TemplateThumb } from '@/components/packaging/PackagingTemplates';
import styles from '@/components/mixcut/mixcut-content.module.css';

const fallback: FinalEditPackagingConfig = { enabled: false, template: 'overlay-poster', varsOverrides: {} };

export default function BatchPackagingEditor({ view, onSave, onJumpToCover }: {
  view: BatchOutputClipEditView;
  onSave: (config: FinalEditPackagingConfig, reextract?: boolean) => Promise<boolean>;
  onJumpToCover: () => void;
}) {
  const config = view.packaging ?? fallback;
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const disabled = busy || !view.editable;
  const save = async (next: FinalEditPackagingConfig, reextract = false) => {
    if (saving.current || !view.editable) return;
    saving.current = true; setBusy(true); setMessage('');
    try { if (!await onSave(next, reextract)) setMessage('保存未成功，请刷新当前成片后重试'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <section className="space-y-3 text-xs text-ink" aria-label="视频包装设置">
    <div className="flex items-center justify-between gap-2">
      <strong>视频包装</strong>
      <button type="button" className={`${styles.pkSwitch} ${config.enabled ? styles.pkSwitchOn : ''}`} role="switch" aria-checked={config.enabled} aria-label="启用视频包装" disabled={disabled} onClick={() => void save({ ...config, enabled: !config.enabled })}>
        <span className={styles.pkSwitchLabel}>{config.enabled ? '已开启' : '已关闭'}</span><span className={styles.pkSwitchKnob} />
      </button>
    </div>
    {!config.enabled && <p className="text-ink-tertiary">开启后可选择模板、字体，包装层直接叠加在预览窗口并同步播放。</p>}
    {config.enabled && <>
      <div className={`${styles.tplGrid} ${styles.tplGridCompact}`} role="radiogroup" aria-label="包装模板">
        {TEMPLATES.map(item => <button type="button" key={item.id} role="radio" aria-checked={config.template === item.id} className={`${styles.tplCard} ${config.template === item.id ? styles.tplCardActive : ''}`} disabled={disabled} title={item.desc} onClick={() => void save({ ...config, template: item.id as FinalEditPackagingConfig['template'] })}>
          <TemplateThumb template={item.id} /><span className={styles.tplName}>{item.name}</span>
        </button>)}
      </div>
      <div className={styles.pkFontRows}>
        {(['title', 'subtitle', 'point'] as const).map((slot, i) => <div key={slot} className={styles.pkFontRow}>
          <span className={styles.pkFontLabel}>{['主标题字体', '副标题字体', '卖点字体'][i]}</span>
          <FontPicker slot={slot} current={config[`${slot}Font`] ?? null} onSelect={(font, file) => void save({ ...config, [`${slot}Font`]: { family: font.family, file } })} onSelectNone={() => void save({ ...config, [`${slot}Font`]: undefined })} disabled={disabled} />
          {slot === 'point' && <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={() => fileInput.current?.click()}>上传字体</button>}
        </div>)}
      </div>
      <input ref={fileInput} type="file" hidden accept=".ttf,.otf,.woff2" onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file || saving.current) return;
        saving.current = true; setBusy(true); setMessage('');
        try {
          const body = new FormData(); body.set('font', file); body.set('slot', 'point');
          const response = await fetch('/api/packaging/user-font', { method: 'POST', body }); const result = await response.json();
          if (!response.ok) throw new Error(result.message || '字体上传失败');
          if (!await onSave({ ...config, pointFont: { family: file.name, file: result.font } })) setMessage('字体未保存，请重试');
        } catch (error) { setMessage(error instanceof Error ? error.message : '字体上传失败'); }
        finally { saving.current = false; setBusy(false); }
      }} />
      <p className="text-ink-tertiary">双击中央预览中的标题或卖点直接改字；拖动调整位置。正片卖点在时间轴上调整时间。</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={onJumpToCover}>跳到封面</button>
        <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={() => void save({ ...config, layouts: { ...config.layouts, [config.template]: {} } })}>恢复默认版式</button>
        <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={() => void save(config, true)}>重新提取卖点</button>
        <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={() => void save({ ...config, varsOverrides: {} })}>恢复默认文案</button>
      </div>
      <p className="text-ink-tertiary">修改自动保存；预览为近似效果，最终以导出渲染为准。</p>
    </>}
    {message && <p role="alert" className="text-fail">{message}</p>}
  </section>;
}
