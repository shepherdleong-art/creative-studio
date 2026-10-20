'use client';

import { useState } from 'react';
import type { FilmContent } from '@/lib/final-edit/reassembled/content';
import type { PackagingPointLayout, PackagingTemplateId } from '@/lib/media-core/packaging-vars';
import { moveCalloutPoint, trimCalloutTime } from '@/lib/final-edit/reassembled/callout-edit';

const templates: Array<[PackagingTemplateId, string]> = [['overlay-poster', 'A 花字种草'], ['overlay-journal', 'B 手账拼贴'], ['overlay-minimal', 'C 极简高级'], ['overlay-variety', 'D 综艺撕纸']];
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 12, alignItems: 'center', marginBlock: 10 };

/** Mounting opens an immutable revision baseline; a failed save never remounts or discards the draft. */
export function ReassembledContentEditor({ initial, original, revision, busy, onSave, onClose }: {
  initial: FilmContent; original: FilmContent; revision: number; busy: boolean;
  onSave: (content: FilmContent, revision: number) => Promise<boolean>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [baseline] = useState(revision);
  const [section, setSection] = useState('packaging');
  const change = (edit: (next: FilmContent) => void) => setDraft(previous => { const next = structuredClone(previous); edit(next); return next; });
  const text = (label: string, value: string, edit: (value: string) => void, maxLength = 100) => <label>{label} <input aria-label={label} value={value} maxLength={maxLength} onChange={e => edit(e.target.value)} /></label>;
  const number = (label: string, value: number, edit: (value: number) => void, step = 1) => <label>{label} <input aria-label={label} type="number" value={value} step={step} onChange={e => edit(Number(e.target.value))} style={{ width: 90 }} /></label>;
  const d = draft.decoration;
  const layout = (label: string, section: 'cover' | 'cues', id: string) => {
    if (d.template === 'classic') return null;
    const current = d.packaging.layouts?.[d.template]?.[section]?.[id];
    const set = (key: keyof PackagingPointLayout, value: number) => change(next => {
      if (next.decoration.template === 'classic') return;
      const p = next.decoration.packaging, template = next.decoration.template;
      p.layouts ??= {}; p.layouts[template] ??= {}; p.layouts[template][section] ??= {};
      p.layouts[template][section]![id] = { x: 50, y: section === 'cover' ? 25 : 65, scale: 1, ...current, [key]: value };
    });
    return <div style={row}><span>{label}版式（画布百分比）</span>{current ? <>
      {number(`${label} X`, current.x, v => set('x', v), .1)}{number(`${label} Y`, current.y, v => set('y', v), .1)}
      {number(`${label} 大小`, current.scale, v => set('scale', v), .1)}{number(`${label} 旋转`, current.rotate || 0, v => set('rotate', v))}
      <button type="button" onClick={() => change(next => { if (next.decoration.template !== 'classic') delete next.decoration.packaging.layouts?.[next.decoration.template]?.[section]?.[id]; })}>恢复默认位置</button>
    </> : <button type="button" onClick={() => set('x', 50)}>自定义位置</button>}</div>;
  };
  return <section aria-label="成片内容编辑" style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: 16 }}>
    <h3>包装、字幕与音乐 · 编辑版本 {baseline}</h3>
    <p>修改保留为本地草稿，保存后生效。时间以完整成片为准；classic 标注跟随所属镜头，使用导入时的镜头时间。</p>
    <div style={row}>{[['packaging', '包装'], ['subtitles', '字幕'], ['music', '音乐']].map(([id, name]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}</div>
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      {section === 'packaging' && <>
        <label>包装模板 <select aria-label="包装模板" value={d.template} onChange={e => change(next => {
          const template = e.target.value;
          if (template === 'classic' && original.decoration.template === 'classic') { next.decoration = structuredClone(original.decoration); return; }
          if (next.decoration.template === 'classic') {
            const cover = next.decoration.cover;
            next.decoration = { template: template as PackagingTemplateId, packaging: { enabled: true, template: template as PackagingTemplateId, varsOverrides: { title: cover.title.join(''), subtitle: cover.tag || cover.productName }, pointCues: [], pointCuesMode: 'none', layouts: {} } };
          } else { next.decoration.template = template as PackagingTemplateId; next.decoration.packaging.template = template as PackagingTemplateId; }
        })}>{original.decoration.template === 'classic' && <option value="classic">classic 原设计</option>}{templates.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        {d.template !== 'classic' ? <>
          {(['title', 'subtitle', 'point1', 'point2', 'point3'] as const).map((key, i) => { const name = ['主标题', '副标题', '封面卖点 1', '封面卖点 2', '封面卖点 3'][i]; return <div key={key}>
            {text(name, d.packaging.varsOverrides[key] || '', value => change(next => { if (next.decoration.template !== 'classic') next.decoration.packaging.varsOverrides[key] = value; }))}{layout(name, 'cover', key)}
          </div>; })}
          <p>封面卖点留空即隐藏。正文卖点删除后不自动重新提取；主副标题目前须非空。</p>
          {(d.packaging.pointCues || []).map((cue, i) => <div key={cue.id}>
            <div style={row}>{text(`正文卖点 ${i + 1}`, cue.text, value => change(next => { if (next.decoration.template !== 'classic') next.decoration.packaging.pointCues![i].text = value; }), 60)}
              {number(`卖点 ${i + 1} 开始秒`, cue.startSec, value => change(next => { if (next.decoration.template !== 'classic') next.decoration.packaging.pointCues![i].startSec = value; }), 1 / 24)}
              {number(`卖点 ${i + 1} 结束秒`, cue.endSec, value => change(next => { if (next.decoration.template !== 'classic') next.decoration.packaging.pointCues![i].endSec = value; }), 1 / 24)}
              <button type="button" onClick={() => change(next => { if (next.decoration.template === 'classic') return; const p = next.decoration.packaging; p.pointCues!.splice(i, 1); p.pointCuesMode = p.pointCues!.length ? 'timed' : 'none'; for (const value of Object.values(p.layouts || {})) delete value.cues?.[cue.id]; })}>删除卖点 {i + 1}</button>
            </div>{layout(`卖点 ${i + 1}`, 'cues', cue.id)}
          </div>)}
          <button type="button" onClick={() => change(next => { if (next.decoration.template === 'classic') return; const p = next.decoration.packaging; p.pointCues ??= []; const startSec = p.pointCues.at(-1)?.endSec ?? 20 / 24; p.pointCues.push({ id: crypto.randomUUID().slice(0, 20), text: '新卖点', startSec, endSec: startSec + 2 }); p.pointCuesMode = 'timed'; })}>新增正文卖点</button>
        </> : <>
          <p>切换到四套模板时 classic 标签、引线和片尾不会带入；切回 classic 会恢复导入时设计，请在保存前核对。</p>
          <div style={row}>{d.cover.title.map((value, i) => <span key={i}>{text(`封面标题 ${i + 1}`, value, v => change(next => { if (next.decoration.template === 'classic') next.decoration.cover.title[i] = v; }))}</span>)}</div>
          <div style={row}>{(['tag', 'note', 'brand', 'model', 'productName'] as const).map(key => <span key={key}>{text({ tag: '封面标签', note: '封面说明', brand: '品牌', model: '型号', productName: '产品名' }[key], d.cover[key], v => change(next => { if (next.decoration.template === 'classic') next.decoration.cover[key] = v; }))}</span>)}</div>
          {Object.entries(d.labels).map(([id, labels]) => <div style={row} key={id}><span>镜头 {id}</span>{labels.map((value, i) => <span key={i}>{text(`${id} 标签 ${i + 1}`, value, v => change(next => { if (next.decoration.template === 'classic') next.decoration.labels[id][i] = v; }))}</span>)}</div>)}
          {d.callouts.map((cue, i) => <div key={cue.id} style={row}>
            {text(`标注 ${i + 1} 标题`, cue.title, v => change(next => { if (next.decoration.template === 'classic') next.decoration.callouts[i].title = v; }))}
            {text(`标注 ${i + 1} 说明`, cue.sub || '', v => change(next => { if (next.decoration.template === 'classic') next.decoration.callouts[i].sub = v; }))}
            {(['startFrame', 'endFrame'] as const).map(key => <span key={key}>{number(`标注 ${i + 1} ${key === 'startFrame' ? '开始帧' : '结束帧'}`, cue[key], v => change(next => { if (next.decoration.template === 'classic') trimCalloutTime(next.decoration.callouts[i], key, v); }))}</span>)}
            {(['dot', 'pill'] as const).flatMap(key => [0, 1].map(axis => <span key={`${key}${axis}`}>{number(`标注 ${i + 1} ${key === 'dot' ? '圆点' : '卡片'} ${axis ? 'Y' : 'X'}`, cue[key][axis], v => change(next => { if (next.decoration.template === 'classic') moveCalloutPoint(next.decoration.callouts[i], key, axis, v); }))}</span>))}
            {cue.dotKeyframes && <button type="button" onClick={() => change(next => { if (next.decoration.template === 'classic') delete next.decoration.callouts[i].dotKeyframes; })}>改为固定圆点 {i + 1}</button>}
            <button type="button" onClick={() => change(next => { if (next.decoration.template === 'classic') next.decoration.callouts.splice(i, 1); })}>删除标注 {i + 1}</button>
          </div>)}
          <div style={row}>{d.outro.title.map((value, i) => <span key={i}>{text(`片尾标题 ${i + 1}`, value, v => change(next => { if (next.decoration.template === 'classic') next.decoration.outro.title[i] = v; }))}</span>)}</div>
        </>}
      </>}
      {section === 'subtitles' && <><p>修改字幕不会重新生成配音，请检查文字与声音一致。</p>{draft.subtitles.map((cue, i) => <div style={row} key={i}>
        {text(`字幕 ${i + 1}`, cue.text, v => change(next => { next.subtitles[i].text = v; }), 300)}
        {number(`字幕 ${i + 1} 开始帧`, cue.startFrame, v => change(next => { next.subtitles[i].startFrame = v; }))}
        {number(`字幕 ${i + 1} 结束帧`, cue.endFrame, v => change(next => { next.subtitles[i].endFrame = v; }))}
        <button type="button" onClick={() => change(next => { next.subtitles.splice(i, 1); })}>删除字幕 {i + 1}</button>
      </div>)}<button type="button" onClick={() => change(next => { const startFrame = next.subtitles.at(-1)?.endFrame || 20; next.subtitles.push({ text: '新字幕', startFrame, endFrame: startFrame + 24 }); })}>新增字幕</button></>}
      {section === 'music' && <div style={row}>{(['inSec', 'gainDb', 'fadeInSec', 'fadeOutSec'] as const).map(key => <span key={key}>{number({ inSec: '音乐入点（秒）', gainDb: '音乐音量（dB）', fadeInSec: '淡入（秒）', fadeOutSec: '淡出（秒）' }[key], draft.music[key], v => change(next => { next.music[key] = v; }), .1)}</span>)}</div>}
      <div style={row}><button className="btn-primary" type="button" onClick={async () => { if (await onSave(draft, baseline)) onClose(); }}>保存成片内容</button><button className="btn-secondary" type="button" onClick={onClose}>取消修改</button></div>
    </fieldset>
  </section>;
}
