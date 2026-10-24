'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { FormulaProductionOptions, FormulaProductionSettings } from '@/lib/live-mixcut/formula/production-settings';

export default function FormulaProductionSettingsPanel({ value, options, disabled, groupId, onChange }: {
  value: FormulaProductionSettings; options: FormulaProductionOptions; disabled: boolean; groupId: string;
  onChange: (value: FormulaProductionSettings) => void;
}) {
  const tts = value.audio.tts;
  const provider = options.voices.find(item => item.id === tts?.providerId);
  const [auditioningVoice, setAuditioningVoice] = useState<string | null>(null);
  const [auditionError, setAuditionError] = useState('');
  const auditionAudio = useRef<HTMLAudioElement | null>(null);
  const auditionRequest = useRef(0);
  function stopAudition() {
    auditionRequest.current += 1;
    auditionAudio.current?.pause();
    auditionAudio.current = null;
    setAuditioningVoice(null);
  }
  useEffect(() => () => {
    auditionAudio.current?.pause();
    auditionAudio.current = null;
  }, []);
  async function audition() {
    if (!tts || !provider?.configured) return;
    if (auditioningVoice) {
      stopAudition();
      return;
    }
    setAuditionError('');
    setAuditioningVoice(tts.voice);
    const request = auditionRequest.current + 1;
    auditionRequest.current = request;
    try {
      const response = await fetch(`/api/providers/tts/${encodeURIComponent(tts.providerId)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: tts.voice, speed: tts.speed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || '音色试听失败');
      }
      const url = URL.createObjectURL(await response.blob());
      if (request !== auditionRequest.current) {
        URL.revokeObjectURL(url);
        return;
      }
      const audio = new Audio(url);
      auditionAudio.current = audio;
      const release = () => {
        URL.revokeObjectURL(url);
        if (auditionAudio.current === audio) {
          auditionAudio.current = null;
          setAuditioningVoice(null);
        }
      };
      audio.addEventListener('ended', release, { once: true });
      audio.addEventListener('error', release, { once: true });
      await audio.play();
    } catch (error) {
      if (request !== auditionRequest.current) return;
      setAuditionError(error instanceof Error ? error.message : '音色试听失败');
      setAuditioningVoice(null);
    }
  }
  return <section aria-label="声音和包装设置" className="space-y-5 border-t border-hairline pt-4">
    <h3 className="font-medium text-ink">声音、画幅和包装</h3>
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-2 text-sm font-medium text-ink">声音方式</legend>
      <div className="flex flex-wrap gap-4">{([
        ['mixed', '原声优先，其余配音'], ['original', '只用真人原声'], ['narration', '统一配音'],
      ] as const).map(([mode, label]) => <label key={mode} className="flex items-center gap-2 text-sm text-ink">
        <input type="radio" name={`formula-audio-${groupId}`} checked={value.audio.mode === mode} onChange={() => onChange({ ...value,
          audio: { mode, tts: mode === 'original' ? null : tts } })} />{label}
      </label>)}</div>
      <p className="text-xs text-ink-secondary">{value.audio.mode === 'mixed'
        ? '保留可用口播原声，只为原声未覆盖的文案配音，不重复念同一句。纯原声和统一配音用于手动覆盖。'
        : value.audio.mode === 'original' ? '只保留核验后的真人口播；脚本文案作为参考，不自动转成配音或逐字字幕。'
          : '用配音朗读已确认文案，视频原声默认静音。遇到说话嘴型时，需要检查旁白与画面的搭配。'}</p>
      {value.audio.mode !== 'original' && <>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm text-ink">配音供应商
            <select className="input-field" aria-label="公式配音供应商" value={tts?.providerId ?? ''} onChange={event => {
              stopAudition(); setAuditionError('');
              const next = options.voices.find(item => item.id === event.target.value);
              onChange({ ...value, audio: { ...value.audio, tts: next ? { providerId: next.id, voice: next.voices[0]?.id ?? '', speed: 1 } : null } });
            }}>
              <option value="">暂不选择</option>
              {tts && !provider && <option value={tts.providerId} disabled>之前选择的供应商已不可用</option>}
              {options.voices.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.name}{item.configured ? '' : '（未配置）'}</option>)}
            </select>
          </label>
          {tts && <>
            <label className="space-y-1 text-sm text-ink">配音音色
              <select className="input-field" aria-label="公式配音音色" value={tts.voice} onChange={event => {
                stopAudition(); setAuditionError('');
                onChange({ ...value, audio: { ...value.audio, tts: { ...tts, voice: event.target.value } } });
              }}>
                {!provider?.voices.some(item => item.id === tts.voice) && <option value={tts.voice} disabled>之前选择的音色已不可用</option>}
                {provider?.voices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm text-ink">配音语速
              <input className="input-field" aria-label="公式配音语速" type="number" min={0.5} max={2} step={0.1} value={Number.isFinite(tts.speed) ? tts.speed : ''}
                onChange={event => {
                  stopAudition(); setAuditionError('');
                  onChange({ ...value, audio: { ...value.audio, tts: { ...tts, speed: event.target.value === '' ? Number.NaN : Number(event.target.value) } } });
                }} />
            </label>
          </>}
        </div>
        {!tts && <p className="text-xs text-warn">尚未选择配音音色，可以先保存设置。只需原声的成片可继续；其他需要自动配音的片段须先选择音色。</p>}
        {tts && <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              disabled={!!auditioningVoice || !provider?.configured} onClick={() => void audition()}>
              <Icon name={auditioningVoice ? 'pause' : 'play'} size={11} />
              {auditioningVoice ? '停止试听' : '试听当前音色'}
            </button>
            {auditionError && <span role="alert" className="text-xs text-fail">{auditionError}</span>}
          </div>
          <p className="text-xs text-ink-secondary">语速为 0.5～2.0 倍，按 0.1 调整；仅作用于配音，不改变真人原声速度。</p>
        </>}
      </>}
    </fieldset>
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-2 text-sm font-medium text-ink">画幅与视频包装</legend>
      <label className="block max-w-xs space-y-1 text-sm text-ink">输出画幅
        <select className="input-field" aria-label="输出画幅" value={value.outputPreset} onChange={event => onChange({ ...value, outputPreset: event.target.value as FormulaProductionSettings['outputPreset'] })}>
          <option value="9x16">9:16 竖屏 · 1080×1920</option><option value="3x4">3:4 竖屏 · 1080×1440</option><option value="16x9">16:9 横屏 · 1920×1080</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-4">{([['none', '不加包装'], ['uniform', '整批统一包装'], ['random', '随机分配包装']] as const).map(([mode, label]) => <label key={mode} className="flex items-center gap-2 text-sm text-ink">
        <input type="radio" name={`formula-packaging-${groupId}`} checked={value.packaging.mode === mode} onChange={() => onChange({ ...value,
          packaging: { mode, templateIds: mode === 'none' ? [] : mode === 'uniform' ? [value.packaging.templateIds[0] ?? options.templates[0]?.id].filter(Boolean) : value.packaging.templateIds },
          cover: { mode: 'default', presetIds: [] } })} />{label}
      </label>)}</div>
      {value.packaging.mode !== 'none' && <div className="grid gap-2 sm:grid-cols-2">{options.templates.map(item => <label key={item.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-surface-subtle p-3 text-sm text-ink">
        <input type={value.packaging.mode === 'uniform' ? 'radio' : 'checkbox'} name={`formula-template-${groupId}`} checked={value.packaging.templateIds.includes(item.id)} onChange={event => onChange({ ...value, packaging: { ...value.packaging,
          templateIds: value.packaging.mode === 'uniform' ? [item.id] : event.target.checked ? [...value.packaging.templateIds, item.id] : value.packaging.templateIds.filter(id => id !== item.id) },
          cover: { mode: 'default', presetIds: [] } })} />{item.name}
      </label>)}</div>}
      {value.packaging.mode === 'random' && <p className="text-xs text-ink-secondary">从勾选模板中为每条成片分配一个；只有一个候选时按统一处理。开始制作后固定结果，刷新和重试不重新抽取。</p>}
      <p className="text-xs text-ink-secondary">{value.packaging.mode === 'none'
        ? '不加包装时使用默认封面，不叠加标题样式。'
        : '包装模板同时决定封面效果，封面文字由包装模板显示，无需另外选择封面预设。'}</p>
    </fieldset>
  </section>;
}
