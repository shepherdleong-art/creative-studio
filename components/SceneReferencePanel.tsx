'use client';

import { useState, useEffect, useCallback } from 'react';
import ImagePickerGrid from '@/components/ImagePickerGrid';
import { Icon } from '@/components/ui/Icon';

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
  const [showArchived, setShowArchived] = useState(false);

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

  // Escape key to close creation modal
  useEffect(() => {
    if (!isCreating) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCreate();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCreating, closeCreate]);

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

  const handleRestore = async (refId: string) => {
    await fetch(`/api/scene-references/${refId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    await loadRefs();
  };

  const handleDelete = async (refId: string) => {
    if (!confirm('确定永久删除该场景参考图？不影响已生成的图片文件。')) return;
    await fetch(`/api/scene-references/${refId}`, { method: 'DELETE' });
    await loadRefs();
  };

  const getImageUrl = (assetId: string) => images.find((img) => img.id === assetId)?.imageUrl || '';

  const activeRefs = refs.filter((r) => r.status === 'active');
  const archivedRefs = refs.filter((r) => r.status === 'archived');

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">场景参考图</h2>
        <button onClick={openCreate} className="btn-secondary btn-sm text-xs"><Icon name="plus" size={13} /> 新增</button>
      </div>

      {/* Scene Reference creation modal */}
      {isCreating && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          onClick={closeCreate}
        >
          <div
            className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-[18px] bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b p-4">
              <h3 className="font-semibold">新增场景参考图</h3>
              <button onClick={closeCreate} className="icon-btn" title="关闭" aria-label="关闭">
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto p-4">
              <div>
                <label className="label">名称</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="input-field"
                  placeholder="例如：现代风客厅"
                  autoFocus
                />
              </div>

              <div>
                <label className="label">选择图片</label>
                <ImagePickerGrid
                  items={images
                    .filter((img) => img.role === 'output' || img.role === 'input')
                    .map((img) => ({
                      id: img.id,
                      label: img.filename,
                      filename: img.filename,
                      imageUrl: img.imageUrl,
                    }))}
                  selectedId={newImageId}
                  onSelect={setNewImageId}
                  emptyText="当前项目没有可选择的图片。"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t bg-white p-4">
              <button onClick={closeCreate} className="btn-secondary btn-sm">取消</button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || !newImageId || saving}
                className="btn-primary btn-sm"
              >
                {saving ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-tertiary">加载中...</p>
      ) : activeRefs.length === 0 ? (
        <p className="text-sm text-ink-tertiary">暂无场景参考图。将审核通过的结果图保存为场景模板，供分镜组批量引用。</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
          {activeRefs.map((ref) => (
            <div key={ref.id} className="border rounded-lg overflow-hidden group">
              <div className="aspect-square bg-surface-subtle">
                <img src={getImageUrl(ref.imageAssetId)} alt={ref.name} className="w-full h-full object-cover" />
              </div>
              <div className="p-2">
                <div className="text-xs font-medium truncate">{ref.name}</div>
                <div className="truncate text-[10px] text-ink-tertiary">{ref.imageFilename}</div>
                <div className="flex items-center gap-2 mt-1">
                  {onApplyToShotSet && (
                    <button onClick={() => onApplyToShotSet(ref.id)} className="link-accent text-[10px]">应用到分镜组</button>
                  )}
                  <button onClick={() => handleArchive(ref.id)} className="ml-auto text-[10px] text-ink-tertiary hover:text-ink-secondary">归档</button>
                  <button onClick={() => handleDelete(ref.id)} className="text-[10px] text-fail hover:underline">删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && archivedRefs.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-ink"
          >
            <Icon name="chevron-right" size={13} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
            已归档 ({archivedRefs.length})
          </button>
          {showArchived && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 mt-2">
              {archivedRefs.map((ref) => (
                <div key={ref.id} className="border rounded-lg overflow-hidden opacity-70">
                  <div className="aspect-square bg-surface-subtle">
                    <img src={getImageUrl(ref.imageAssetId)} alt={ref.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium truncate">{ref.name}</div>
                    <div className="truncate text-[10px] text-ink-tertiary">{ref.imageFilename}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <button onClick={() => handleRestore(ref.id)} className="text-[10px] text-ok hover:underline">恢复</button>
                      <button onClick={() => handleDelete(ref.id)} className="ml-auto text-[10px] text-fail hover:underline">删除</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
