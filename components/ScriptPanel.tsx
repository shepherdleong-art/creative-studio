'use client';

import { useState, useEffect, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';

interface ScriptShot {
  shotIndex: number;
  duration: string;
  voiceover: string;
  subtitle: string;
  visualIntent: string;
}

interface ScriptDraft {
  id: string;
  provider: string;
  model: string;
  inputSnapshot: string;
  outputJson: string;
  createdAt: string;
}

interface Props {
  projectId: string;
}

export default function ScriptPanel({ projectId }: Props) {
  const [generating, setGenerating] = useState(false);
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('种草');
  const [platform, setPlatform] = useState('通用');
  const [sellingPoints, setSellingPoints] = useState('');
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [script, setScript] = useState<{
    title: string;
    platform: string;
    tone: string;
    shots: ScriptShot[];
    fullScript: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<ScriptDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const initialLoadDone = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/script`);
        const data = await res.json().catch(() => ({ drafts: [] }));
        if (!active) return;
        if (data.drafts) {
          setDrafts(data.drafts);
          if (!initialLoadDone.current && data.drafts.length > 0) {
            initialLoadDone.current = true;
            setSelectedDraftId(data.drafts[0].id);
            setScript(JSON.parse(data.drafts[0].outputJson));
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [projectId]);

  // Load brief from project
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        const data = await res.json();
        if (!active || data.error) return;
        setAudience(data.targetAudience || '');
        setTone(data.scriptTone || '种草');
        setPlatform(data.scriptPlatform || '通用');
        try { setSellingPoints(JSON.parse(data.sellingPointsJson || '[]').map((s: { title: string }) => s.title).join('\n')); } catch { setSellingPoints(''); }
        setBriefLoaded(true);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [projectId]);

  const saveBrief = async () => {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAudience: audience,
        scriptTone: tone,
        scriptPlatform: platform,
        sellingPointsJson: JSON.stringify(sellingPoints.trim().split('\n').filter(Boolean).map((s) => ({ title: s.trim(), priority: 0 }))),
      }),
    });
    if (!res.ok) throw new Error('保存卖点失败');
  };

  const handleGenerate = async () => {
    if (!briefLoaded) { alert('卖点信息加载中，请稍后再试'); return; }
    setGenerating(true);
    try { await saveBrief(); } catch { alert('保存卖点失败'); setGenerating(false); return; }
    try {
      const res = await fetch(`/api/projects/${projectId}/script`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setScript(data.script);
        // Reload drafts list
        const listRes = await fetch(`/api/projects/${projectId}/script`);
        const listData = await listRes.json().catch(() => ({ drafts: [] }));
        if (listData.drafts) {
          setDrafts(listData.drafts);
          if (listData.drafts.length > 0) {
            setSelectedDraftId(listData.drafts[0].id);
          }
        }
      } else {
        alert('脚本生成失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      alert('生成失败: ' + String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleSelectDraft = (draftId: string) => {
    const draft = drafts.find((d) => d.id === draftId);
    if (draft) {
      setSelectedDraftId(draftId);
      setScript(JSON.parse(draft.outputJson));
    }
  };

  const handleCopyFullScript = async () => {
    if (!script?.fullScript) return;
    try {
      await navigator.clipboard.writeText(script.fullScript);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = script.fullScript;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTxt = () => {
    if (!script) return;
    const text = `# ${script.title}\n平台: ${script.platform}\n语气: ${script.tone}\n\n## 完整口播稿\n\n${script.fullScript}\n\n## 分镜详情\n\n${script.shots.map((s) => `### 分镜 ${s.shotIndex} (${s.duration})\n口播: ${s.voiceover}\n字幕: ${s.subtitle}\n视觉意图: ${s.visualIntent}`).join('\n\n')}`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${script.title || 'script'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    if (!script) return;
    const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${script.title || 'script'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 font-semibold"><Icon name="file-text" size={16} /> 脚本生成</h2>
        <div className="flex gap-2">
          {drafts.length > 1 && (
            <select
              value={selectedDraftId || ''}
              onChange={(e) => handleSelectDraft(e.target.value)}
              className="input-field text-xs w-48"
            >
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {new Date(d.createdAt + 'Z').toLocaleString('zh-CN')}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="btn-primary btn-sm"
          >
            {generating ? '生成中...' : '生成脚本'}
          </button>
        </div>
      </div>

      {/* Brief form */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div>
        <label className="label">目标人群</label>
          <input value={audience} onChange={(e) => setAudience(e.target.value)} className="input-field text-sm" placeholder="25-35岁女性" />
        </div>
        <div>
          <label className="label">语气</label>
          <select value={tone} onChange={(e) => setTone(e.target.value)} className="input-field text-sm">
            {['种草','专业','温柔生活方式','促销'].map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
        </div>
        <div>
          <label className="label">平台</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="input-field text-sm">
            {['抖音','小红书','视频号','通用'].map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </div>
      </div>
      <div className="mb-4">
        <label className="label">卖点（每行一条）</label>
        <textarea value={sellingPoints} onChange={(e) => setSellingPoints(e.target.value)} rows={3}
          className="input-field text-sm" placeholder={'1. 软包靠背，久靠舒服\n2. 奶油色百搭，适合小户型\n3. 床架稳固，视觉轻盈'} />
      </div>

      {!script && !generating && (
        <p className="text-sm text-ink-tertiary">
          基于项目信息、分镜顺序和产品卖点，通过 Gemini 生成结构化口播脚本。需要先配置环境变量 GEMINI_API_KEY。
        </p>
      )}

      {generating && (
        <div className="py-8 text-center text-ink-tertiary">
          <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Gemini 正在生成脚本...
        </div>
      )}

      {script && (
        <div className="space-y-4">
          {/* Meta */}
          <div className="flex gap-4 text-xs text-ink-secondary">
            <span>标题: <strong className="text-ink">{script.title}</strong></span>
            <span>平台: {script.platform}</span>
            <span>语气: {script.tone}</span>
          </div>

          {/* Shot-by-shot table */}
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th className="pb-2 pr-2">#</th>
                  <th className="pb-2 pr-2">时长</th>
                  <th className="pb-2 pr-2">口播</th>
                  <th className="pb-2 pr-2">字幕</th>
                  <th className="pb-2">视觉意图</th>
                </tr>
              </thead>
              <tbody>
                {script.shots.map((shot) => (
                  <tr key={shot.shotIndex} className="align-top">
                    <td className="py-2 pr-2 text-ink-secondary">{shot.shotIndex}</td>
                    <td className="py-2 pr-2 text-xs text-ink-secondary">{shot.duration}</td>
                    <td className="py-2 pr-2">{shot.voiceover}</td>
                    <td className="py-2 pr-2 text-ink-secondary">{shot.subtitle}</td>
                    <td className="py-2 text-xs text-ink-tertiary">{shot.visualIntent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Full script */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-ink-secondary">完整口播稿</h4>
            <pre className="whitespace-pre-wrap rounded bg-surface-subtle p-3 text-sm leading-relaxed text-ink-secondary">
              {script.fullScript}
            </pre>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button onClick={handleCopyFullScript} className="btn-secondary btn-sm text-xs">
              {copied ? <><Icon name="check" size={13} /> 已复制</> : <><Icon name="copy" size={13} /> 复制完整口播</>}
            </button>
            <button onClick={handleDownloadTxt} className="btn-secondary btn-sm text-xs">
              <Icon name="download" size={13} /> 下载 .txt
            </button>
            <button onClick={handleDownloadJson} className="btn-secondary btn-sm text-xs">
              <Icon name="download" size={13} /> 下载 .json
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
