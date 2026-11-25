'use client';

import { useEffect, useRef, useState } from 'react';
import type { FinalEditPackagingConfig } from '@/lib/media-core/packaging-vars';
import { requestSystemFonts, type FontOption } from '@/components/system-fonts';
import { FontPicker } from '@/components/mixcut/FontPicker';
import { TEMPLATES, TemplateThumb } from './PackagingTemplates';
import styles from '@/components/mixcut/mixcut-content.module.css';

type Appearance = Pick<FinalEditPackagingConfig, 'template' | 'pointFont' | 'titleFont' | 'subtitleFont'>;

export function PackagingAppearanceControls({ config, disabled: locked, inlinePanel = false, sharedFonts = false, onChange }: {
  config: Appearance;
  disabled: boolean;
  inlinePanel?: boolean;
  sharedFonts?: boolean;
  onChange: (patch: Partial<Appearance>) => void | Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const disabled = locked || uploading;
  const [catalog, setCatalog] = useState<FontOption[]>([]);
  useEffect(() => {
    if (sharedFonts) void requestSystemFonts().then(setCatalog).catch(() => setMessage('团队字体目录暂时不可用'));
  }, [sharedFonts]);
  return <>
      <div className={`${styles.tplGrid} ${styles.tplGridCompact}`} role="radiogroup" aria-label="包装模板">
        {TEMPLATES.map(item => <button type="button" key={item.id} role="radio" aria-checked={config.template === item.id} className={`${styles.tplCard} ${config.template === item.id ? styles.tplCardActive : ''}`} disabled={disabled} title={item.desc} onClick={() => onChange({ template: item.id as FinalEditPackagingConfig['template'] })}>
          <TemplateThumb template={item.id} /><span className={styles.tplName}>{item.name}</span>
        </button>)}
      </div>
      <div className={styles.pkFontRows}>
        {(['title', 'subtitle', 'point'] as const).map((slot, i) => <div key={slot} className={styles.pkFontRow}>
          <span className={styles.pkFontLabel}>{['主标题字体', '副标题字体', '卖点字体'][i]}</span>
          {sharedFonts ? <select aria-label={['主标题字体', '副标题字体', '卖点字体'][i]} className="input-field"
            disabled={disabled} value={config[`${slot}Font`]?.file ?? ''} onChange={event => {
              const font = catalog.find(item => item.previewUrl === event.target.value);
              onChange({ [`${slot}Font`]: font ? { family: font.family, file: font.previewUrl } : undefined });
            }}>
            <option value="">模板原生字体</option>
            {catalog.filter(font => font.previewUrl).map(font => <option key={font.family} value={font.previewUrl}>{font.displayName}</option>)}
          </select> : <FontPicker slot={slot} inlinePanel={inlinePanel} current={config[`${slot}Font`] ?? null} onSelect={(font, file) => onChange({ [`${slot}Font`]: { family: font.family, file } })} onSelectNone={() => onChange({ [`${slot}Font`]: undefined })} disabled={disabled} />}
          {!sharedFonts && slot === 'point' && <button type="button" className="btn-secondary px-2 py-1" disabled={disabled} onClick={() => fileInput.current?.click()}>上传字体</button>}
        </div>)}
      </div>
      <input ref={fileInput} type="file" hidden accept=".ttf,.otf,.woff2" onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file || saving.current) return;
        saving.current = true; setUploading(true); setMessage('');
        try {
          const body = new FormData(); body.set('font', file); body.set('slot', 'point');
          const response = await fetch('/api/packaging/user-font', { method: 'POST', body }); const result = await response.json();
          if (!response.ok) throw new Error(result.message || '字体上传失败');
          await onChange({ pointFont: { family: file.name, file: result.font } });
        } catch (error) { setMessage(error instanceof Error ? error.message : '字体上传失败'); }
        finally { saving.current = false; setUploading(false); }
      }} />
    {message && <p role="alert" className="text-fail">{message}</p>}
  </>;
}
