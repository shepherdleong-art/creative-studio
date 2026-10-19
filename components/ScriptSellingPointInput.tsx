'use client';

import { Icon } from '@/components/ui/Icon';
import type { ProviderMeta } from '@/lib/script-providers';

interface Props {
  sellingPoints: string;
  onSellingPointsChange: (value: string) => void;
  audience: string;
  onAudienceChange: (value: string) => void;
  tone: string;
  onToneChange: (value: string) => void;
  platform: string;
  onPlatformChange: (value: string) => void;
  providerId: string;
  onProviderIdChange: (value: string) => void;
  providers: ProviderMeta[];
  onAnalyze: () => void;
  analyzing: boolean;
}

const TONES = ['种草', '专业', '温柔生活方式', '促销'];
const PLATFORMS = ['抖音', '小红书', '视频号', '淘宝', '天猫', '通用'];

export default function ScriptSellingPointInput({
  sellingPoints,
  onSellingPointsChange,
  audience,
  onAudienceChange,
  tone,
  onToneChange,
  platform,
  onPlatformChange,
  providerId,
  onProviderIdChange,
  providers,
  onAnalyze,
  analyzing,
}: Props) {
  const configuredProviders = providers.filter((p) => p.configured);
  const analysisProvider = providers.find((p) => p.id === providerId);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">① 输入卖点与受众信息</h3>
        <p className="mb-4 text-xs text-ink-tertiary">
          输入产品卖点、目标人群和平台，AI 会分析每个卖点的优先级和推荐模版。
        </p>
      </div>

      {/* Grid: info fields */}
      <div className="script-brief-grid grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="script-field">
          <label className="label">目标人群</label>
          <input
            value={audience}
            onChange={(e) => onAudienceChange(e.target.value)}
            className="input-field script-control"
            placeholder="例：25-35岁独居女性"
          />
        </div>
        <div className="script-field">
          <label className="label">语气</label>
          <select value={tone} onChange={(e) => onToneChange(e.target.value)} className="input-field script-control script-select">
            {TONES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="script-field">
          <label className="label">平台</label>
          <select value={platform} onChange={(e) => onPlatformChange(e.target.value)} className="input-field script-control script-select">
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Selling points textarea */}
      <div>
        <label className="label">
          卖点（一行一条，建议 3-10 条）
        </label>
        <textarea
          value={sellingPoints}
          onChange={(e) => onSellingPointsChange(e.target.value)}
          rows={5}
          className="input-field text-sm"
          placeholder={'1. 软包靠背，久坐不累\n2. 奶油色百搭，适合小户型\n3. 床架加厚钢板，承重300kg\n4. 无需工具，女生也能5分钟安装\n5. 床底15cm空间，扫地机器人自由进出'}
        />
      </div>

      {/* Model selector + Analyze button */}
      <div className="script-action-row">
        <div className="script-field script-model-field">
          <label className="label script-model-label flex items-center gap-1.5">
            <Icon name="cpu" size={13} />
            分析模型
          </label>
          <select
            value={providerId}
            onChange={(e) => onProviderIdChange(e.target.value)}
            className="input-field script-control script-select"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.name} {!p.configured ? '(未配置)' : ''}
              </option>
            ))}
          </select>
        </div>

        {analysisProvider && !analysisProvider.configured && (
          <span className="script-action-warning text-fail">
            请在 .env.local 配置对应 API Key
          </span>
        )}

        <button
          onClick={onAnalyze}
          disabled={analyzing || configuredProviders.length === 0}
          className="btn-primary script-primary-action"
        >
          {analyzing ? (
            <>
              <div className="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              分析中...
            </>
          ) : (
            <>
              <Icon name="sparkle" size={14} />
              开始分析
            </>
          )}
        </button>
      </div>

      {/* Provider status summary */}
      <div className="flex flex-wrap gap-3 text-[0.7rem] text-ink-tertiary">
        {providers.map((p) => (
          <span key={p.id} className={`inline-flex items-center gap-1 ${p.configured ? '' : 'opacity-50'}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${p.configured ? 'bg-ok' : 'bg-hairline'}`} />
            {p.name} {p.configured ? `(${p.model})` : '未配置'}
          </span>
        ))}
      </div>
    </div>
  );
}
