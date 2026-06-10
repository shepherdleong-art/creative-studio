'use client';

import { useState, useEffect, useCallback } from 'react';

interface SceneReference {
  id: string;
  name: string;
  productCode: string;
  category: string;
  imageAssetId: string;
  imageFilename: string;
  sourceJobId: string;
  status: string;
  createdAt: string;
}

interface Props {
  projectId: string;
  images: Array<{ id: string; imageUrl?: string; filename: string; role: string }>;
  onApplyToShotSet?: (refId: string) => void;
}

export default function SceneReferencePanel({ projectId, images, onApplyToShotSet }: Props) {
  const [refs, setRefs] = useState<SceneReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newImageId, setNewImageId] = useState('');

  const loadRefs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/scene-references`);
      const data = await res.json();
      if (Array.isArray(data)) setRefs(data);
    } catch { /* ignore */ }
    return undefined;
  }, [projectId]);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadRefs();
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [loadRefs]);

  const openCreate = () => { setIsCreating(true); setNewName(''); setNewImageId(''); };
  const closeCreate = () => { setIsCreating(false); setNewName(''); setNewImageId(''); };

  const handleCreate = async () => {
    if (!newName.trim() || !newImageId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/scene-references`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), imageAssetId: newImageId }),
      });
      if (res.ok) { closeCreate(); await loadRefs(); }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleArchive = async (refId: string) => {
    await fetch(`/api/scene-references/${refId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    await loadRefs();
  };

  const getImageUrl = (assetId: string) => images.find((img) => img.id === assetId)?.imageUrl || '';

  const activeRefs = refs.filter((r) => r.status === 'active');

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">场景参考图</h2>
        <button onClick={openCreate} className="btn-secondary btn-sm text-xs">+ 新增</button>
      </div>

      {isCreating && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-2">
          <div>
            <label className="text-xs text-gray-500">名称</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input-field text-sm" placeholder="例如: 现代奶油风卧室" />
          </div>
          <div>
            <label className="text-xs text-gray-500">选择图片</label>
            <select value={newImageId} onChange={(e) => setNewImageId(e.target.value)} className="input-field text-sm">
              <option value="">-- 选择项目图片 --</option>
              {images.filter((img) => img.role === 'output' || img.role === 'input').map((img) => (
                <option key={img.id} value={img.id}>{img.filename}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={!newName.trim() || !newImageId || saving} className="btn-primary btn-sm text-xs">{saving ? '创建中...' : '创建'}</button>
            <button onClick={closeCreate} className="btn-secondary btn-sm text-xs">取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">加载中...</p>
      ) : activeRefs.length === 0 ? (
        <p className="text-sm text-gray-400">暂无场景参考图。将审核通过的结果图保存为场景模板，供分镜组批量引用。</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
          {activeRefs.map((ref) => (
            <div key={ref.id} className="border rounded-lg overflow-hidden group">
              <div className="aspect-square bg-gray-100">
                <img src={getImageUrl(ref.imageAssetId)} alt={ref.name} className="w-full h-full object-cover" />
              </div>
              <div className="p-2">
                <div className="text-xs font-medium truncate">{ref.name}</div>
                <div className="text-[10px] text-gray-400 truncate">{ref.imageFilename}</div>
                <div className="flex gap-1 mt-1">
                  {onApplyToShotSet && (
                    <button onClick={() => onApplyToShotSet(ref.id)} className="text-[10px] text-purple-600 hover:text-purple-800">应用到分镜组</button>
                  )}
                  <button onClick={() => handleArchive(ref.id)} className="text-[10px] text-gray-400 hover:text-gray-600 ml-auto">归档</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
