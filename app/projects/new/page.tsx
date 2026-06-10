'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ProviderSettings from '@/components/ProviderSettings';
import ImageUploader from '@/components/ImageUploader';
import type { UploadedFile } from '@/components/ImageUploader';
import {
  GPT_IMAGE_2_ASPECT_RATIOS,
  GPT_IMAGE_2_RESOLUTIONS,
  GPT_IMAGE_2_SIZE_MAP,
  resolveGptImage2Size,
} from '@/lib/gpt-image-2-size-presets';

const PRICE_TABLE: Record<string, Record<string, number>> = {
  low: {
    '1024x1024':0.045, '1248x832':0.036, '832x1248':0.036, '1152x864':0.036, '864x1152':0.036,
    '1120x896':0.036, '896x1120':0.036, '1280x720':0.036, '720x1280':0.036,
    '2048x1024':0.09, '1024x2048':0.09, '1456x624':0.036, '624x1456':0.036,
  },
  medium: {
    '1024x1024':0.398, '1248x832':0.311, '832x1248':0.311, '1152x864':0.311, '864x1152':0.311,
    '1120x896':0.311, '896x1120':0.311, '1280x720':0.32, '720x1280':0.32,
    '2048x2048':0.808, '2496x1664':0.808, '1664x2496':0.808, '2304x1728':0.808, '1728x2304':0.808,
    '2240x1792':0.808, '1792x2240':0.808, '2560x1440':0.808, '1440x2560':0.808,
    '2688x1344':0.808, '1344x2688':0.808, '3024x1296':0.808, '1296x3024':0.808,
  },
  high: {
    '1024x1024':1.59, '1248x832':1.24, '832x1248':1.24, '1152x864':1.24, '864x1152':1.24,
    '1120x896':1.24, '896x1120':1.24, '1280x720':1.28, '720x1280':1.28,
    '2048x2048':3.231, '2496x1664':3.231, '1664x2496':3.231, '2304x1728':3.231, '1728x2304':3.231,
    '2240x1792':3.231, '1792x2240':3.231, '2560x1440':3.231, '1440x2560':3.231,
    '2688x1344':3.231, '1344x2688':3.231, '3024x1296':3.231, '1296x3024':3.231,
  },
};

function getEstimatedCost(size: string, quality: string): number {
  return PRICE_TABLE[quality]?.[size] ?? 0;
}

interface Provider {
  id: string; name: string; model: string; type: string; hasApiKey?: boolean; defaultCostPerImage?: number;
}

const DEFAULT_SCENE_PROMPT = '基于图1生成新的室内产品场景图。保留适合家居产品展示的空间关系，重构墙面、软装、灯光、窗帘、地面和整体氛围，使画面更适合电商生活方式图。不要添加文字，不要生成不真实的连接件。';

const DEFAULT_SHOT_PROMPT = `图1 是待编辑分镜图，是本次修改的主要对象。
图2 是场景参考图。
请参考图2的空间风格、光线、墙面、软装和布置，重绘图1的场景。
保持图1中的产品结构、模特姿态、主体位置和画面构图尽量一致。
不要改变产品结构，不要让人物或产品变形，不要添加文字。`;

const TONE_OPTIONS = ['种草', '专业', '温柔生活方式', '促销'] as const;
const PLATFORM_OPTIONS = ['抖音', '小红书', '视频号', '通用'] as const;

export default function NewProjectPage() {
  const router = useRouter();

  // ── Project info ──
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [category, setCategory] = useState('');
  const [workflowType, setWorkflowType] = useState<'complex_product' | 'legacy_batch_edit'>('complex_product');

  // ── Provider / Model ──
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState('gpt-image-2');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1k');
  const [quality, setQuality] = useState('medium');
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [generationCount, setGenerationCount] = useState(4);
  const [sceneConcurrency, setSceneConcurrency] = useState(3);

  const size = useMemo(() => {
    try { return resolveGptImage2Size(aspectRatio, resolution); }
    catch { return ''; }
  }, [aspectRatio, resolution]);

  // ── Scene A (seed image) ──
  const [sceneAFiles, setSceneAFiles] = useState<UploadedFile[]>([]);

  // ── Scene B generation ──
  const [scenePrompt, setScenePrompt] = useState(DEFAULT_SCENE_PROMPT);

  // ── Shot images ──
  const [shotFiles, setShotFiles] = useState<UploadedFile[]>([]);

  // ── Shot redo template ──
  const [shotPrompt, setShotPrompt] = useState(DEFAULT_SHOT_PROMPT);

  // ── Product brief ──
  const [targetAudience, setTargetAudience] = useState('');
  const [tone, setTone] = useState<string>('种草');
  const [platform, setPlatform] = useState<string>('通用');
  const [sellingPoints, setSellingPoints] = useState('');

  // ── Preprocessing ──
  const [preprocessEnabled, setPreprocessEnabled] = useState(true);
  const [targetMaxSide, setTargetMaxSide] = useState(1536);
  const [jpegQuality, setJpegQuality] = useState(85);

  // ── Legacy fields ──
  const [legacyPrompt, setLegacyPrompt] = useState('');
  const [legacyNegativePrompt, setLegacyNegativePrompt] = useState('');
  const [legacyRefFiles, setLegacyRefFiles] = useState<UploadedFile[]>([]);
  const [legacyInputFiles, setLegacyInputFiles] = useState<UploadedFile[]>([]);
  const [legacyConcurrency, setLegacyConcurrency] = useState(3);
  const [legacyMaxAttempts, setLegacyMaxAttempts] = useState(2);

  const [creating, setCreating] = useState(false);

  const costPerImage = getEstimatedCost(size, quality) || provider?.defaultCostPerImage || 0;

  const handleSubmitComplex = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { alert('请输入项目名称'); return; }
    if (!provider) { alert('请选择供应商'); return; }
    if (!provider.hasApiKey) { alert('当前供应商未配置 API Key'); return; }
    if (sceneAFiles.length === 0) { alert('请上传场景图 A'); return; }
    if (shotFiles.length === 0) { alert('请上传至少 1 张原始分镜图'); return; }

    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, productName, productCode, category,
          workflowType: 'complex_product',
          providerId: provider.id, model, size, quality, timeoutMs,
          generationCount, aspectRatio, resolution,
          concurrency: sceneConcurrency,
          sceneSeedImageId: sceneAFiles[0].id,
          scenePrompt,
          shotImageIds: shotFiles.map((f) => f.id),
          shotPrompt,
          targetAudience, tone, platform,
          sellingPoints: sellingPoints.trim() ? sellingPoints.trim().split('\n').filter(Boolean).map((s) => ({ title: s.trim(), priority: 0 })) : undefined,
          preprocessEnabled, targetMaxSide, jpegQuality,
        }),
      });
      const data = await res.json();
      if (data.id) {
        await fetch(`/api/projects/${data.id}/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', concurrency: sceneConcurrency, maxAttempts: 1, timeoutMs }),
        });
        router.push(`/projects/${data.id}`);
      } else {
        alert('创建失败: ' + (data.error || '未知错误'));
      }
    } catch (err) { alert('创建失败: ' + String(err)); }
    finally { setCreating(false); }
  };

  const handleSubmitLegacy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { alert('请输入项目名称'); return; }
    if (!provider) { alert('请选择供应商'); return; }
    if (!legacyPrompt.trim()) { alert('请输入提示词'); return; }
    if (legacyInputFiles.length === 0) { alert('请上传待处理图片'); return; }
    if (!provider.hasApiKey) { alert('当前供应商未配置 API Key'); return; }
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, workflowType: 'legacy_batch_edit',
          providerId: provider.id, model,
          prompt: legacyPrompt, negativePrompt: legacyNegativePrompt,
          aspectRatio, resolution, size, quality,
          concurrency: legacyConcurrency, maxAttempts: legacyMaxAttempts, timeoutMs,
          referenceImageIds: legacyRefFiles.map((f) => f.id),
          inputImageIds: legacyInputFiles.map((f) => f.id),
        }),
      });
      const data = await res.json();
      if (data.id) {
        await fetch(`/api/projects/${data.id}/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', concurrency: legacyConcurrency, maxAttempts: legacyMaxAttempts, timeoutMs }),
        });
        router.push(`/projects/${data.id}`);
      } else { alert('创建失败: ' + (data.error || '未知错误')); }
    } catch (err) { alert('创建失败: ' + String(err)); }
    finally { setCreating(false); }
  };

  const renderModelParams = () => (
    <div className="card p-4">
      <h3 className="font-medium text-sm mb-3">模型参数</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className="label">模型</label>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="label">画面比例</label>
          <select value={aspectRatio} onChange={(e) => { setAspectRatio(e.target.value); const avail = Object.keys(GPT_IMAGE_2_SIZE_MAP[e.target.value] || {}); if (!avail.includes(resolution)) setResolution(avail[0] || '1k'); }} className="input-field">
            {GPT_IMAGE_2_ASPECT_RATIOS.map((r) => (<option key={r} value={r}>{r}</option>))}
          </select>
        </div>
        {aspectRatio !== 'auto' && (
        <div>
          <label className="label">清晰度</label>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="input-field">
            {GPT_IMAGE_2_RESOLUTIONS.map((r) => (
              <option key={r} value={r} disabled={!(GPT_IMAGE_2_SIZE_MAP[aspectRatio] || {})[r]}>{r}{GPT_IMAGE_2_SIZE_MAP[aspectRatio]?.[r] ? ` → ${GPT_IMAGE_2_SIZE_MAP[aspectRatio][r]}` : ' — 不支持'}</option>
            ))}
          </select>
        </div>
        )}
        <div>
          <label className="label">质量</label>
          <select value={quality} onChange={(e) => setQuality(e.target.value)} className="input-field">
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </div>
        <div>
          <label className="label">超时(秒)</label>
          <input type="number" min={30} max={600} value={Math.floor(timeoutMs / 1000)}
            onChange={(e) => setTimeoutMs(Number(e.target.value) * 1000)} className="input-field" />
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-2">以上为参考价格，实际以中转站后台扣费为准</p>
    </div>
  );

  const renderPreprocessing = () => (
    <div className="card p-4">
      <h3 className="font-medium text-sm mb-3">图片预处理</h3>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">启用压缩</label>
          <select value={preprocessEnabled ? '1' : '0'} onChange={(e) => setPreprocessEnabled(e.target.value === '1')} className="input-field">
            <option value="1">开启</option><option value="0">关闭（使用原图）</option>
          </select>
        </div>
        <div>
          <label className="label">最长边</label>
          <select value={targetMaxSide} onChange={(e) => setTargetMaxSide(Number(e.target.value))} className="input-field" disabled={!preprocessEnabled}>
            <option value={1024}>1024</option><option value={1536}>1536（推荐）</option><option value={2048}>2048</option><option value={4096}>4096（原图）</option>
          </select>
        </div>
        <div>
          <label className="label">JPEG 质量</label>
          <select value={jpegQuality} onChange={(e) => setJpegQuality(Number(e.target.value))} className="input-field" disabled={!preprocessEnabled}>
            <option value={70}>70</option><option value={85}>85（推荐）</option><option value={95}>95</option>
          </select>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">
        {workflowType === 'complex_product' ? '新建复杂结构产品项目' : '新建批量编辑项目'}
      </h1>

      {/* Mode toggle */}
      <div className="mb-6 flex items-center gap-2">
        <span className="text-xs text-gray-500">工作流：</span>
        <label className={`text-xs px-3 py-1 rounded-full cursor-pointer transition-colors ${workflowType === 'complex_product' ? 'bg-purple-100 text-purple-700 font-medium' : 'bg-gray-100 text-gray-500'}`}>
          <input type="radio" name="workflow" value="complex_product" checked={workflowType === 'complex_product'}
            onChange={() => setWorkflowType('complex_product')} className="sr-only" />
          复杂结构产品
        </label>
        <label className={`text-xs px-3 py-1 rounded-full cursor-pointer transition-colors ${workflowType === 'legacy_batch_edit' ? 'bg-gray-200 text-gray-700 font-medium' : 'bg-gray-100 text-gray-500'}`}>
          <input type="radio" name="workflow" value="legacy_batch_edit" checked={workflowType === 'legacy_batch_edit'}
            onChange={() => setWorkflowType('legacy_batch_edit')} className="sr-only" />
          旧版批量编辑
        </label>
      </div>

      {workflowType === 'legacy_batch_edit' ? (
        /* ── Legacy batch edit form ── */
        <form onSubmit={handleSubmitLegacy} className="space-y-8">
          <div>
            <label className="label">项目名称</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="例如：春季家居图批量处理" />
          </div>
          <ProviderSettings selectedId={provider?.id} onSelect={(p) => { setProvider(p); setModel(p.model); }} />
          <ImageUploader role="reference" label="参考图" hint="上传 1-3 张参考图" maxFiles={3}
            files={legacyRefFiles} onUploaded={(files) => setLegacyRefFiles((p) => [...p, ...files])}
            onRemove={(i) => setLegacyRefFiles((p) => p.filter((_, idx) => idx !== i))}
            preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
          <ImageUploader role="input" label="待处理图片" hint="上传需要批量编辑的图片，最多 50 张" maxFiles={50}
            files={legacyInputFiles} onUploaded={(files) => setLegacyInputFiles((p) => [...p, ...files])}
            onRemove={(i) => setLegacyInputFiles((p) => p.filter((_, idx) => idx !== i))}
            preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
          <div>
            <label className="label">提示词</label>
            <textarea value={legacyPrompt} onChange={(e) => setLegacyPrompt(e.target.value)} rows={3} className="input-field" placeholder="描述你想要的生成效果..." />
          </div>
          <div>
            <label className="label">每张生成数量</label>
            <input type="number" min={1} max={10} value={generationCount} onChange={(e) => setGenerationCount(Math.max(1, Number(e.target.value)))} className="input-field w-24" />
          </div>
          {renderModelParams()}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">并发数</label>
              <input type="number" min={1} max={8} value={legacyConcurrency} onChange={(e) => setLegacyConcurrency(Number(e.target.value))} className="input-field" />
            </div>
            <div>
              <label className="label">重试次数</label>
              <input type="number" min={0} max={5} value={legacyMaxAttempts} onChange={(e) => setLegacyMaxAttempts(Number(e.target.value))} className="input-field" />
            </div>
          </div>
          {renderPreprocessing()}
          <div className="card p-4 bg-blue-50 border-blue-200">
            <h3 className="font-medium text-sm mb-2">成本预估（参考价）</h3>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-gray-500">任务数</div><div className="font-bold text-lg">{legacyInputFiles.length * generationCount}</div></div>
              <div><div className="text-gray-500">单张成本</div><div className="font-bold text-lg">¥{costPerImage.toFixed(3)}</div></div>
              <div><div className="text-gray-500">预估总成本</div><div className="font-bold text-lg text-blue-700">¥{(legacyInputFiles.length * generationCount * costPerImage).toFixed(2)}</div></div>
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <Link href="/" className="btn-secondary">取消</Link>
            <button type="submit" disabled={creating} className="btn-primary">{creating ? '创建中...' : '创建并开始运行'}</button>
          </div>
        </form>
      ) : (
        /* ── Complex product workflow ── */
        <form onSubmit={handleSubmitComplex} className="space-y-8">
          {/* 1. Project info */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-3">项目信息</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">项目名称 *</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="例如：奶油风软包床" />
              </div>
              <div>
                <label className="label">产品名称</label>
                <input type="text" value={productName} onChange={(e) => setProductName(e.target.value)} className="input-field" placeholder="例如：奶油风软包床" />
              </div>
              <div>
                <label className="label">产品编号</label>
                <input type="text" value={productCode} onChange={(e) => setProductCode(e.target.value)} className="input-field" placeholder="可选" />
              </div>
              <div>
                <label className="label">品类</label>
                <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} className="input-field" placeholder="可选，例如：卧室家具" />
              </div>
            </div>
          </div>

          {/* 2. Provider */}
          <ProviderSettings selectedId={provider?.id} onSelect={(p) => { setProvider(p); setModel(p.model); }} />

          {/* 3. Scene A */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-2">场景图 A</h3>
            <p className="text-xs text-gray-500 mb-3">上传 1 张原始场景图 / 灵感场景图，用于生成新的场景图 B。</p>
            <ImageUploader role="input" label="场景图 A" maxFiles={1}
              files={sceneAFiles} onUploaded={(files) => setSceneAFiles((p) => [...p, ...files])}
              onRemove={(i) => setSceneAFiles((p) => p.filter((_, idx) => idx !== i))}
              preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
          </div>

          {/* 4. Scene B generation */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-3">生成场景图 B</h3>
            <div>
              <label className="label">场景生成提示词</label>
              <textarea value={scenePrompt} onChange={(e) => setScenePrompt(e.target.value)} rows={4} className="input-field text-sm font-mono" />
            </div>
            <div className="flex gap-4 mt-3">
              <div>
                <label className="label">生成数量</label>
                <input type="number" min={1} max={9} value={generationCount}
                  onChange={(e) => setGenerationCount(Math.max(1, Math.min(9, Number(e.target.value))))} className="input-field w-20" />
              </div>
              <div>
                <label className="label">并发数</label>
                <input type="number" min={1} max={8} value={sceneConcurrency}
                  onChange={(e) => setSceneConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className="input-field w-20" />
              </div>
              <div>
                <label className="label">预估成本</label>
                <div className="text-lg font-bold text-blue-700">¥{(generationCount * costPerImage).toFixed(2)}</div>
                <p className="text-[10px] text-gray-400">{generationCount} 张 × ¥{costPerImage.toFixed(3)}</p>
              </div>
            </div>
          </div>

          {/* 5. Shot images */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-2">原始分镜图</h3>
            <p className="text-xs text-gray-500 mb-3">上传 1-9 张选好的原始分镜图。后续会让每张分镜参考同一个场景图 B 重新生成。点击顺序即为分镜顺序。</p>
            <ImageUploader role="input" label="原始分镜图" maxFiles={9}
              files={shotFiles} onUploaded={(files) => setShotFiles((p) => [...p, ...files])}
              onRemove={(i) => setShotFiles((p) => p.filter((_, idx) => idx !== i))}
              preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
            {shotFiles.length > 0 && (
              <div className="grid grid-cols-5 sm:grid-cols-9 gap-2 mt-3">
                {shotFiles.map((file, i) => (
                  <div key={file.id} className="relative">
                    <div className="aspect-square bg-gray-100 rounded border">
                      <img src={file.imageUrl} alt={file.filename} className="w-full h-full object-cover rounded" />
                    </div>
                    <div className="absolute top-1 left-1 w-4 h-4 bg-purple-500 text-white rounded-full flex items-center justify-center text-[9px] font-bold">{i + 1}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 6. Shot redo template */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-2">分镜重做模板</h3>
            <p className="text-xs text-gray-500 mb-2">图1 = 每张原始分镜图，图2 = 选中的场景图B。确认场景图 B 后会批量应用此模板。</p>
            <textarea value={shotPrompt} onChange={(e) => setShotPrompt(e.target.value)} rows={5} className="input-field text-sm font-mono" />
          </div>

          {/* 7. Product brief */}
          <div className="card p-4">
            <h3 className="font-medium text-sm mb-3">产品卖点（用于后续 15 秒口播文案）</h3>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <label className="label">目标人群</label>
                <input type="text" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} className="input-field" placeholder="可选，例如：25-35岁女性" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="label">语气</label>
                  <select value={tone} onChange={(e) => setTone(e.target.value)} className="input-field">
                    {TONE_OPTIONS.map((t) => (<option key={t} value={t}>{t}</option>))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="label">平台</label>
                  <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="input-field">
                    {PLATFORM_OPTIONS.map((p) => (<option key={p} value={p}>{p}</option>))}
                  </select>
                </div>
              </div>
            </div>
            <div>
              <label className="label">卖点（每行一条）</label>
              <textarea value={sellingPoints} onChange={(e) => setSellingPoints(e.target.value)} rows={4}
                className="input-field text-sm" placeholder={'1. 软包靠背，久靠舒服\n2. 奶油色百搭，适合小户型卧室\n3. 床架稳固，视觉轻盈\n4. 适合拍生活方式种草视频'} />
            </div>
          </div>

          {/* 8. Model params */}
          {renderModelParams()}
          {renderPreprocessing()}

          {/* Submit */}
          <div className="flex gap-3 justify-end">
            <Link href="/" className="btn-secondary">取消</Link>
            <button type="submit" disabled={creating} className="btn-primary">
              {creating ? '创建中...' : '创建项目并生成场景图 B'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
