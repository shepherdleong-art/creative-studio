'use client';

import { useState, useEffect, useCallback } from 'react';

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

  const loadDrafts = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/script`);
      const data = await res.json().catch(() => ({ drafts: [] }));
      if (data.drafts) {
        setDrafts(data.drafts);
        // Auto-select latest
        if (data.drafts.length > 0 && !selectedDraftId) {
          setSelectedDraftId(data.drafts[0].id);
          setScript(JSON.parse(data.drafts[0].outputJson));
        }
      }
    } catch { /* ignore */ }
  }, [projectId, selectedDraftId]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/script`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setScript(data.script);
        await loadDrafts();
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
        <h2 className="font-semibold">📝 脚本生成</h2>
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

      {!script && !generating && (
        <p className="text-sm text-gray-400">
          基于项目信息、分镜顺序和产品卖点，通过 Gemini 生成结构化口播脚本。需要先配置环境变量 GEMINI_API_KEY。
        </p>
      )}

      {generating && (
        <div className="text-center py-8 text-gray-400">
          <div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2" />
          Gemini 正在生成脚本...
        </div>
      )}

      {script && (
        <div className="space-y-4">
          {/* Meta */}
          <div className="flex gap-4 text-xs text-gray-500">
            <span>标题: <strong className="text-gray-700">{script.title}</strong></span>
            <span>平台: {script.platform}</span>
            <span>语气: {script.tone}</span>
          </div>

          {/* Shot-by-shot table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 text-xs">
                  <th className="pb-2 pr-2">#</th>
                  <th className="pb-2 pr-2">时长</th>
                  <th className="pb-2 pr-2">口播</th>
                  <th className="pb-2 pr-2">字幕</th>
                  <th className="pb-2">视觉意图</th>
                </tr>
              </thead>
              <tbody>
                {script.shots.map((shot) => (
                  <tr key={shot.shotIndex} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-2 text-gray-500">{shot.shotIndex}</td>
                    <td className="py-2 pr-2 text-gray-500 text-xs">{shot.duration}</td>
                    <td className="py-2 pr-2">{shot.voiceover}</td>
                    <td className="py-2 pr-2 text-gray-600">{shot.subtitle}</td>
                    <td className="py-2 text-gray-400 text-xs">{shot.visualIntent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Full script */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-1">完整口播稿</h4>
            <pre className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 p-3 rounded leading-relaxed">
              {script.fullScript}
            </pre>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button onClick={handleCopyFullScript} className="btn-secondary btn-sm text-xs">
              {copied ? '已复制 ✓' : '复制完整口播'}
            </button>
            <button onClick={handleDownloadTxt} className="btn-secondary btn-sm text-xs">
              下载 .txt
            </button>
            <button onClick={handleDownloadJson} className="btn-secondary btn-sm text-xs">
              下载 .json
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
