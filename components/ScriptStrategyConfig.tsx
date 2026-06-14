'use client';

import { Icon } from '@/components/ui/Icon';
import ScriptTemplatePicker from './ScriptTemplatePicker';
import type { AnalysisResult, ProviderMeta } from '@/lib/script-providers';

interface ShotSetOption {
  id: string;
  name: string;
  shotCount: number;
  status: string;
}

interface Props {
  analysis: AnalysisResult;
  selectedSellingPoints: string[];
  onSellingPointsChange: (points: string[]) => void;
  templateId: string;
  onTemplateIdChange: (id: string, name: string) => void;
  templateName: string;
  duration: string;
  onDurationChange: (d: string) => void;
  providers: ProviderMeta[];
  providerId: string;
  onProviderIdChange: (id: string) => void;
  shotSets: ShotSetOption[];
  selectedShotSetId: string;
  onShotSetIdChange: (id: string) => void;
  onGenerate: () => void;
  generating: boolean;
}

const DURATIONS = ['15s', '20s', '30s', '60s'];

const PRIORITY_CONFIG: Record<string, { label: string; className: string }> = {
  highest: { label: '最优先', className: 'bg-fail-tint text-fail' },
  high: { label: '优先', className: 'bg-accent-tint text-accent' },
  medium: { label: '可选', className: 'bg-surface-subtle text-ink-secondary' },
  low: { label: '弱化', className: 'text-ink-tertiary' },
};

export default function ScriptStrategyConfig({
  analysis,
  selectedSellingPoints,
  onSellingPointsChange,
  templateId,
  onTemplateIdChange,
  templateName: _templateName,
  duration,
  onDurationChange,
  providers,
  providerId,
  onProviderIdChange,
  shotSets,
  selectedShotSetId,
  onShotSetIdChange,
  onGenerate,
  generating,
}: Props) {
  const configuredProviders = providers.filter((p) => p.configured);
  const hasShotSets = shotSets.length > 0;

  const toggleSellingPoint = (title: string) => {
    if (selectedSellingPoints.includes(title)) {
      onSellingPointsChange(selectedSellingPoints.filter((s) => s !== title));
    } else {
      onSellingPointsChange([...selectedSellingPoints, title]);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">② 策略配置</h3>
        <p className="mb-1 text-xs text-ink-tertiary">
          确认 AI 分析的卖点排名、选择脚本模版和时长，然后生成。
        </p>
      </div>

      {/* Audience insight + Platform advice */}
      {(analysis.audienceInsight || analysis.platformAdvice) && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {analysis.audienceInsight && (
            <div className="tile rounded-[14px] p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-medium text-ink-tertiary">
                <Icon name="users" size={12} /> 人群洞察
              </div>
              <p className="text-xs leading-relaxed text-ink-secondary">{analysis.audienceInsight}</p>
            </div>
          )}
          {analysis.platformAdvice && (
            <div className="tile rounded-[14px] p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-medium text-ink-tertiary">
                <Icon name="monitor" size={12} /> 平台建议
              </div>
              <p className="text-xs leading-relaxed text-ink-secondary">{analysis.platformAdvice}</p>
            </div>
          )}
        </div>
      )}

      {/* Ranking list */}
      <div>
        <label className="label mb-2">📊 卖点优先级（勾选要使用的卖点）</label>
        <div className="space-y-1.5">
          {analysis.rankings.map((r) => {
            const isSelected = selectedSellingPoints.includes(r.title);
            const pc = PRIORITY_CONFIG[r.priority] || PRIORITY_CONFIG.medium;
            return (
              <label
                key={r.rank}
                className={`flex cursor-pointer items-start gap-3 rounded-[14px] border p-3 transition-all ${
                  isSelected
                    ? 'border-accent/30 bg-accent-tint/5'
                    : 'border-hairline bg-surface hover:border-hairline/80'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSellingPoint(r.title)}
                  className="mt-0.5 h-4 w-4 rounded accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[0.65rem] font-semibold ${pc.className}`}>
                      {pc.label}
                    </span>
                    <span className="text-sm font-medium text-ink">{r.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{r.reason}</p>
                  <div className="mt-1 flex items-center gap-1.5 text-[0.65rem] text-ink-tertiary">
                    <Icon name="film" size={10} />
                    推荐模版：{r.recommendedTemplateName}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* Template picker */}
      <div>
        <label className="label mb-2">🎬 脚本模版</label>
        <ScriptTemplatePicker
          selectedId={templateId}
          onSelect={onTemplateIdChange}
        />
      </div>

      {/* Duration + ShotSet */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">⏱ 视频时长</label>
          <div className="flex gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d}
                onClick={() => onDurationChange(d)}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  duration === d
                    ? 'bg-accent text-white'
                    : 'bg-surface-subtle text-ink-secondary hover:bg-surface'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">🎯 分镜组</label>
          {hasShotSets ? (
            <select
              value={selectedShotSetId}
              onChange={(e) => onShotSetIdChange(e.target.value)}
              className="input-field text-sm"
            >
              <option value="">-- 选择分镜组 --</option>
              {shotSets.map((ss) => (
                <option key={ss.id} value={ss.id}>
                  {ss.name}（{ss.shotCount} 个分镜）
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-ink-tertiary">
              暂无分镜组。请先在「分镜」标签页创建分镜组后再生成脚本。
            </p>
          )}
        </div>
      </div>

      {/* Model + Generate */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="label mb-0 flex items-center gap-1.5">
            <Icon name="cpu" size={13} />
            生成模型
          </label>
          <select
            value={providerId}
            onChange={(e) => onProviderIdChange(e.target.value)}
            className="input-field text-xs w-36"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.name} {!p.configured ? '(未配置)' : ''}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={onGenerate}
          disabled={generating || !selectedShotSetId || configuredProviders.length === 0}
          className="btn-primary"
        >
          {generating ? (
            <>
              <div className="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              生成中...
            </>
          ) : (
            <>
              <Icon name="sparkle" size={14} />
              生成脚本
            </>
          )}
        </button>
      </div>
    </div>
  );
}
