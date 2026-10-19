'use client';

import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react';
import { Icon } from '@/components/ui/Icon';

type Motion = {
  id: string;
  prompt: string;
  durationSec: number;
  tailUrl: string | null;
  tailName: string | null;
};

type Shot = {
  id: string;
  name: string;
  imageUrl: string;
  motions: Motion[];
};

type MockResult = {
  id: string;
  shotId: string;
  posterUrl: string;
  durationSec: number;
  prompt: string;
};

function createMotion(index = 0): Motion {
  return {
    id: crypto.randomUUID(),
    prompt: index === 0 ? '镜头缓慢推进，主体保持清晰，光线自然。' : '',
    durationSec: 5,
    tailUrl: null,
    tailName: null,
  };
}

export default function FreeMaterialVideoPrototype() {
  const addImageInputRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [draftMotions, setDraftMotions] = useState<Motion[]>([{
    id: 'motion-initial',
    prompt: '镜头缓慢推进，主体保持清晰，光线自然。',
    durationSec: 5,
    tailUrl: null,
    tailName: null,
  }]);
  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const [results, setResults] = useState<MockResult[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(100);

  const activeShot = shots.find((shot) => shot.id === activeShotId) ?? null;
  const motions = activeShot?.motions ?? draftMotions;
  const shotResults = useMemo(
    () => results.filter((result) => !activeShotId || result.shotId === activeShotId),
    [activeShotId, results],
  );
  const activeResult = results.find((result) => result.id === activeResultId) ?? null;
  const readyMotionCount = motions.filter((motion) => motion.prompt.trim()).length;

  const updateMotions = (updater: (current: Motion[]) => Motion[]) => {
    if (!activeShot) {
      setDraftMotions(updater);
      return;
    }
    setShots((current) => current.map((shot) => (
      shot.id === activeShot.id ? { ...shot, motions: updater(shot.motions) } : shot
    )));
  };

  const addImage = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const shot: Shot = {
      id: crypto.randomUUID(),
      name: file.name,
      imageUrl: URL.createObjectURL(file),
      motions: shots.length === 0 ? draftMotions : [createMotion()],
    };
    setShots((current) => [...current, shot]);
    setActiveShotId(shot.id);
    setActiveResultId(null);
  };

  const handleAddImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) addImage(file);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, onFile: (file: File) => void) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  const updateMotion = (id: string, patch: Partial<Motion>) => {
    updateMotions((current) => current.map((motion) => (
      motion.id === id ? { ...motion, ...patch } : motion
    )));
  };

  const generate = () => {
    if (!activeShot || readyMotionCount === 0) return;
    const next = motions
      .filter((motion) => motion.prompt.trim())
      .map((motion) => ({
        id: crypto.randomUUID(),
        shotId: activeShot.id,
        posterUrl: activeShot.imageUrl,
        durationSec: motion.durationSec,
        prompt: motion.prompt.trim(),
      }));
    setResults((current) => [...next, ...current]);
    setActiveResultId(next[0]?.id ?? null);
    setPlaying(false);
    setProgress(100);
  };

  const selectResult = (id: string) => {
    setActiveResultId(id);
    setPlaying(false);
    setProgress(100);
  };

  return (
    <div className="free-material-prototype">
      <section className="video-generation-section" aria-label="自由素材视频生成 Demo">
        <div className="video-workspace">
          <div className="panel-col left-col">
            <div className="panel-col-header">
              <div className="shot-tab-row" aria-label="图片列表">
                {shots.map((shot, index) => (
                  <button
                    key={shot.id}
                    type="button"
                    className={`shot-tab-item ${shot.id === activeShotId ? 'active' : ''}`}
                    onClick={() => {
                      setActiveShotId(shot.id);
                      setActiveResultId(results.find((result) => result.shotId === shot.id)?.id ?? null);
                    }}
                  >
                    图 {index + 1}
                  </button>
                ))}
                <button
                  type="button"
                  className={`shot-tab-item free-material-add-tab ${shots.length === 0 ? 'active' : ''}`}
                  onClick={() => addImageInputRef.current?.click()}
                >
                  <Icon name="plus" size={13} /> 添加图片
                </button>
              </div>
            </div>

            <div className="panel-scroll-area">
              <div className="space-y-3">
                {motions.map((motion, index) => (
                  <div key={motion.id} className="video-motion-card">
                    <span className="video-motion-label">描述 {index + 1}</span>

                    <div className="video-frame-pair">
                      {activeShot ? (
                        <div className="video-frame-tile video-frame-source">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={activeShot.imageUrl} alt={`图 ${shots.indexOf(activeShot) + 1} 首帧`} className="video-frame-image" />
                          <span className="video-frame-chip">首帧</span>
                        </div>
                      ) : (
                        <label
                          className="video-frame-tile video-frame-empty free-material-head-upload"
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => handleDrop(event, addImage)}
                        >
                          <span className="video-frame-empty-icon">
                            <Icon name="image" size={25} />
                            <span><Icon name="plus" size={10} /></span>
                          </span>
                          <strong>添加首帧图</strong>
                          <small>点击或拖入</small>
                          <input
                            data-testid="head-image-input"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="sr-only"
                            onChange={handleAddImage}
                          />
                        </label>
                      )}

                      <div className="video-frame-bridge" aria-hidden="true">
                        <Icon name="chevron-right" size={18} />
                      </div>

                      {motion.tailUrl ? (
                        <div className="video-frame-tile video-frame-tail">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={motion.tailUrl} alt="尾帧预览" className="video-frame-image" />
                          <span className="video-frame-chip">尾帧</span>
                          <div className="video-frame-actions">
                            <button
                              type="button"
                              className="video-frame-action video-frame-remove"
                              aria-label="移除尾帧"
                              onClick={() => updateMotion(motion.id, { tailUrl: null, tailName: null })}
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <label
                          className={`video-frame-tile video-frame-empty ${activeShot ? '' : 'is-disabled'}`}
                          onDragOver={(event) => activeShot && event.preventDefault()}
                          onDrop={(event) => activeShot && handleDrop(event, (file) => updateMotion(motion.id, {
                            tailUrl: URL.createObjectURL(file),
                            tailName: file.name,
                          }))}
                        >
                          <span className="video-frame-empty-icon">
                            <Icon name="image" size={25} />
                            {activeShot && <span><Icon name="plus" size={10} /></span>}
                          </span>
                          <strong>{activeShot ? '添加尾帧图' : '先添加首帧'}</strong>
                          <small>{activeShot ? '可选 · 点击或拖入' : '添加后可选'}</small>
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="sr-only"
                            disabled={!activeShot}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) updateMotion(motion.id, {
                                tailUrl: URL.createObjectURL(file),
                                tailName: file.name,
                              });
                            }}
                          />
                        </label>
                      )}
                    </div>

                    <select className="input-field video-control" defaultValue="company-kling">
                      <option value="company-kling">公司可灵 3.0</option>
                      <option value="seedance">即梦 1.5 Pro (Seedance)</option>
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <select className="input-field video-control" defaultValue="">
                        <option value="">模板（可选）</option>
                        <option value="steady">稳定运镜</option>
                      </select>
                      <input
                        type="number"
                        min={2}
                        max={15}
                        className="input-field video-control text-center"
                        value={motion.durationSec}
                        aria-label={`描述 ${index + 1} 时长`}
                        onChange={(event) => updateMotion(motion.id, { durationSec: Number(event.target.value) })}
                      />
                    </div>

                    <textarea
                      className="input-field video-prompt-field"
                      value={motion.prompt}
                      placeholder="运镜描述（提示词）"
                      onChange={(event) => updateMotion(motion.id, { prompt: event.target.value })}
                    />

                    <button
                      type="button"
                      className="video-motion-delete"
                      title="删除该描述"
                      disabled={motions.length <= 1}
                      onClick={() => updateMotions((current) => current.filter((item) => item.id !== motion.id))}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="btn-secondary btn-sm w-full video-add-action"
                  onClick={() => updateMotions((current) => [...current, createMotion(current.length)])}
                >
                  <Icon name="plus" size={12} /> 添加描述
                </button>
                <div>
                  <label className="label generation-label" htmlFor="free-material-concurrency">并发数</label>
                  <input
                    id="free-material-concurrency"
                    type="number"
                    min={1}
                    max={10}
                    className="input-field generation-control generation-number"
                    value={concurrency}
                    onChange={(event) => setConcurrency(Number(event.target.value))}
                  />
                  <p className="generation-helper">失败或限流时调回 1。</p>
                </div>
                <button
                  type="button"
                  className="btn-primary btn-sm w-full video-create-action"
                  disabled={!activeShot || readyMotionCount === 0}
                  onClick={generate}
                >
                  生成 {activeShot ? readyMotionCount : 0} 条视频
                </button>
              </div>
            </div>
          </div>

          <div className="panel-col center-col video-preview-col">
            <div className="video-preview-shell">
              <div className="video-preview-fit">
                <div className="video-player-wrap free-material-player">
                  <div className="video-stage">
                    {activeResult ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={activeResult.posterUrl} alt="当前视频预览" />
                    ) : (
                      <div className="stage-placeholder">
                        <Icon name="video" size={30} />
                        <span>{activeShot ? '填写运镜描述并生成视频' : '添加首帧图后开始生成'}</span>
                      </div>
                    )}
                  </div>
                  <div className="stage-controls">
                    <button type="button" className="sc-step-btn" disabled={!activeResult} aria-label="上一个视频">
                      <Icon name="skip-back" size={16} />
                    </button>
                    <button
                      type="button"
                      className="sc-play-btn"
                      disabled={!activeResult}
                      aria-label={playing ? '暂停' : '播放'}
                      onClick={() => setPlaying((current) => !current)}
                    >
                      <Icon name={playing ? 'pause' : 'play'} size={15} />
                    </button>
                    <span className="sc-time">0:0{activeResult?.durationSec ?? 0}</span>
                    <div className="sc-progress-wrap">
                      <input
                        className="sc-progress"
                        type="range"
                        min={0}
                        max={100}
                        value={activeResult ? progress : 0}
                        disabled={!activeResult}
                        aria-label="播放进度"
                        style={{ '--pct': `${activeResult ? progress : 0}%` } as CSSProperties}
                        onChange={(event) => setProgress(Number(event.target.value))}
                      />
                    </div>
                    <span className="sc-time">0:0{activeResult?.durationSec ?? 0}</span>
                    <div className="sc-right">
                      <span className="sc-shot-label">{activeResult ? `${shotResults.indexOf(activeResult) + 1}/${shotResults.length}` : '0/0'}</span>
                      <button type="button" className="sc-icon-btn" disabled={!activeResult} aria-label="音量">
                        <Icon name="speaker" size={15} />
                      </button>
                      <button
                        type="button"
                        className="sc-icon-btn"
                        disabled={!activeResult}
                        aria-label="关闭预览"
                        onClick={() => setActiveResultId(null)}
                      >
                        <Icon name="close" size={15} />
                      </button>
                      <button type="button" className="sc-step-btn" disabled={!activeResult} aria-label="下一个视频">
                        <Icon name="skip-forward" size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="panel-col right-col">
            <div className="panel-scroll-area">
              {shotResults.length === 0 ? (
                <div className="result-empty">
                  <Icon name="video" size={24} />
                  <span>{activeShot ? '生成结果会显示在这里' : '先从左侧添加首帧图'}</span>
                </div>
              ) : shotResults.map((result) => (
                <article key={result.id} className={`result-card ${result.id === activeResult?.id ? 'active' : ''}`}>
                  <button type="button" className="result-thumb free-material-result-thumb" onClick={() => selectResult(result.id)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={result.posterUrl} alt="生成视频封面" />
                    <span className="play-overlay"><Icon name="play-circle" size={28} /></span>
                  </button>
                  <div className="result-info">
                    <div className="result-meta-row">
                      <span className="status-badge status-succeeded result-status">完成</span>
                      <span className="result-meta">公司可灵 3.0 / 自定义 / {result.durationSec}s</span>
                    </div>
                    <div className="result-actions">
                      <a className="result-action" href={result.posterUrl} download>
                        <Icon name="download" size={12} /> 下载
                      </a>
                      <button type="button" className="result-action" onClick={() => selectResult(result.id)}>
                        {result.id === activeResult?.id ? '正在播放' : '播放'}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>

        <input
          ref={addImageInputRef}
          data-testid="add-image-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={handleAddImage}
        />
      </section>
    </div>
  );
}
