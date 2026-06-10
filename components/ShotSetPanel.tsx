'use client';

import { useState, useEffect, useCallback } from 'react';
import VideoGenerationPanel from '@/components/VideoGenerationPanel';

interface Shot {
  id: string;
  indexNum: number;
  sourceImageId: string;
  sourceFilename: string;
  latestGeneratedImageId?: string;
  generatedFilename?: string;
  latestJobId?: string;
  jobStatus?: string;
  reviewMark?: string;
}

interface ShotSet {
  id: string;
  name: string;
  productCode: string;
  category: string;
  shotCount: number;
  generatedCount: number;
  approvedCount: number;
  status: string;
  sceneReferenceId?: string;
  createdAt: string;
}

interface Props {
  projectId: string;
  images: Array<{ id: string; imageUrl?: string; filename: string; role: string }>;
  jobs?: Array<{ id: string; status: string; outputImageId?: string }>;
  onApplyScene?: (shotSetId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', generating: '生成中', reviewing: '审核中', approved: '已通过', video_ready: '待生成视频',
};

export default function ShotSetPanel({ projectId, images, jobs, onApplyScene }: Props) {
  const [sets, setSets] = useState<ShotSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loadingShots, setLoadingShots] = useState(false);

  const loadSets = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`);
      const data = await res.json();
      if (Array.isArray(data)) setSets(data);
    } catch { /* ignore */ }
    return undefined;
  }, [projectId]);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadSets();
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [loadSets]);

  const openCreate = () => { setIsCreating(true); setNewName(''); setSelectedImageIds([]); };
  const closeCreate = () => { setIsCreating(false); setNewName(''); setSelectedImageIds([]); };

  const handleCreate = async () => {
    if (!newName.trim() || selectedImageIds.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), shotImageIds: selectedImageIds }),
      });
      if (res.ok) { closeCreate(); await loadSets(); }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const toggleImage = (imgId: string) => {
    setSelectedImageIds((prev) =>
      prev.includes(imgId) ? prev.filter((id) => id !== imgId) : prev.length < 9 ? [...prev, imgId] : prev
    );
  };

  const loadShots = async (setId: string) => {
    setLoadingShots(true);
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      if (data.shots) setShots(data.shots);
    } catch { /* ignore */ }
    finally { setLoadingShots(false); }
  };

  const handleExpand = (setId: string) => {
    if (expandedId === setId) { setExpandedId(null); return; }
    setExpandedId(setId);
    loadShots(setId);
  };

  const handleDelete = async (setId: string) => {
    if (!confirm('确定删除此分镜组？')) return;
    await fetch(`/api/shot-sets/${setId}`, { method: 'DELETE' });
    if (expandedId === setId) setExpandedId(null);
    await loadSets();
  };

  const getImageUrl = (assetId: string) => images.find((img) => img.id === assetId)?.imageUrl || '';
  const getFilename = (assetId: string) => images.find((img) => img.id === assetId)?.filename || '';
  const getJobStatus = (jobId?: string) => jobs?.find((j) => j.id === jobId)?.status;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">分镜组</h2>
        <button onClick={openCreate} className="btn-secondary btn-sm text-xs">+ 创建分镜组</button>
      </div>

      {isCreating && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-2">
          <div>
            <label className="text-xs text-gray-500">分镜组名称</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input-field text-sm" placeholder="例如: 卧室场景分镜 1-6" />
          </div>
          <div>
            <label className="text-xs text-gray-500">选择分镜图（1-9 张，拖选顺序即分镜顺序）</label>
            <div className="grid grid-cols-5 sm:grid-cols-6 gap-2 mt-1">
              {images.filter((img) => img.role === 'input').map((img, idx) => (
                <div key={img.id} onClick={() => toggleImage(img.id)}
                  className={`relative rounded border-2 cursor-pointer overflow-hidden ${
                    selectedImageIds.includes(img.id) ? 'border-purple-500' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="aspect-square bg-gray-100">
                    {img.imageUrl && <img src={img.imageUrl} alt={img.filename} className="w-full h-full object-cover" />}
                  </div>
                  {selectedImageIds.includes(img.id) && (
                    <div className="absolute top-1 left-1 w-5 h-5 bg-purple-500 text-white rounded-full flex items-center justify-center text-[10px] font-bold">
                      {selectedImageIds.indexOf(img.id) + 1}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">已选 {selectedImageIds.length}/9 张，点击顺序即为分镜顺序</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={!newName.trim() || selectedImageIds.length === 0 || saving}
              className="btn-primary btn-sm text-xs">{saving ? '创建中...' : '创建'}</button>
            <button onClick={closeCreate} className="btn-secondary btn-sm text-xs">取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">加载中...</p>
      ) : sets.length === 0 ? (
        <p className="text-sm text-gray-400">暂无分镜组。选择 1-9 张原始分镜图创建分镜组，配合场景参考图批量生成。</p>
      ) : (
        <div className="space-y-2">
          {sets.map((set) => (
            <div key={set.id}>
              <div className="flex items-center gap-3 p-2 hover:bg-gray-50 rounded cursor-pointer" onClick={() => handleExpand(set.id)}>
                <span className="text-xs text-gray-400">{expandedId === set.id ? '▼' : '▶'}</span>
                <span className="text-sm font-medium flex-1">{set.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${set.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {STATUS_LABELS[set.status] || set.status}
                </span>
                <span className="text-xs text-gray-400">{set.shotCount} 张 | {set.generatedCount} 已生成 | {set.approvedCount} 可用</span>
                {set.generatedCount > 0 && (
                  <a
                    href={`/api/shot-sets/${set.id}/download`}
                    onClick={(e) => e.stopPropagation()}
                    className="btn-secondary btn-sm text-xs text-blue-600"
                  >
                    下载ZIP
                  </a>
                )}
                {onApplyScene && (
                  <button onClick={(e) => { e.stopPropagation(); onApplyScene(set.id); }}
                    className="btn-secondary btn-sm text-xs text-purple-600">批量应用场景</button>
                )}
                <button onClick={(e) => { e.stopPropagation(); handleDelete(set.id); }}
                  className="text-xs text-gray-400 hover:text-red-500">删除</button>
              </div>

              {expandedId === set.id && (
                <div className="ml-6 mb-2 p-3 bg-gray-50 rounded-lg">
                  {loadingShots ? (
                    <p className="text-xs text-gray-400">加载分镜...</p>
                  ) : shots.length === 0 ? (
                    <p className="text-xs text-gray-400">无分镜数据</p>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                      {shots.map((shot) => (
                        <div key={shot.id} className="border rounded overflow-hidden bg-white">
                          <div className="text-[10px] text-gray-400 px-2 pt-1">分镜 {shot.indexNum}</div>
                          <div className="grid grid-cols-2 gap-px">
                            <div>
                              <div className="text-[8px] text-gray-400 text-center">原图</div>
                              <div className="aspect-square bg-gray-100">
                                <img src={getImageUrl(shot.sourceImageId)} alt="原图" className="w-full h-full object-cover" />
                              </div>
                            </div>
                            <div>
                              <div className="text-[8px] text-gray-400 text-center">结果</div>
                              <div className="aspect-square bg-gray-100">
                                {shot.latestGeneratedImageId ? (
                                  <img src={getImageUrl(shot.latestGeneratedImageId)} alt="结果" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">
                                    {shot.latestJobId ? (getJobStatus(shot.latestJobId) === 'running' ? '生成中' : '等待中') : '-'}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="px-2 pb-1 text-[10px] text-gray-400 truncate">{shot.sourceFilename}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Video generation for this shot set */}
                  <VideoGenerationPanel
                    projectId={projectId}
                    shotSetId={set.id}
                    shots={shots.map((s) => ({
                      id: s.id,
                      indexNum: s.indexNum,
                      sourceImageId: s.sourceImageId,
                      latestGeneratedImageId: s.latestGeneratedImageId,
                      imageUrl: getImageUrl(s.latestGeneratedImageId || s.sourceImageId),
                    }))}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
