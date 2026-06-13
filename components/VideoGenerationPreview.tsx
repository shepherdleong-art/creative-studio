'use client';

import { useRef } from 'react';
import { Icon } from '@/components/ui/Icon';

interface VideoJob {
  id: string;
  filename?: string;
  localVideoPath?: string;
  status: string;
}

interface Props {
  videoUrl: string | null;
  posterUrl?: string | null;
  placeholderText: string;
  videoJobs: VideoJob[];
  currentJobId: string | null;
  onNavigate: (jobId: string) => void;
  onClose: () => void;
}

export default function VideoGenerationPreview({ videoUrl, posterUrl, placeholderText, videoJobs, currentJobId, onNavigate, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const succeededJobs = videoJobs.filter((j) => j.status === 'succeeded' && j.filename);
  const currentIndex = currentJobId ? succeededJobs.findIndex((j) => j.id === currentJobId) : -1;

  return (
    <div className="video-preview-shell">
      <div className="video-stage">
        {videoUrl ? (
          <video
            key={videoUrl}
            ref={videoRef}
            src={videoUrl}
            poster={posterUrl || undefined}
            controls
            className="video-player"
          />
        ) : (
          <div className="stage-placeholder">
            <Icon name="video" size={40} />
            <span>{placeholderText}</span>
          </div>
        )}
      </div>
      <div className="stage-controls">
        <button
          onClick={() => {
            if (currentIndex > 0) onNavigate(succeededJobs[currentIndex - 1].id);
          }}
          disabled={currentIndex <= 0}
          style={{ opacity: currentIndex <= 0 ? 0.3 : 1 }}
          title="上一个"
        >
          <Icon name="skip-back" size={16} />
        </button>
        <button onClick={() => videoRef.current?.play()} title="播放">
          <Icon name="play" size={14} />
        </button>
        <button onClick={() => videoRef.current?.pause()} title="暂停">
          <Icon name="pause" size={14} />
        </button>
        <button
          onClick={() => {
            if (currentIndex >= 0 && currentIndex < succeededJobs.length - 1) {
              onNavigate(succeededJobs[currentIndex + 1].id);
            }
          }}
          disabled={currentIndex < 0 || currentIndex >= succeededJobs.length - 1}
          style={{ opacity: currentIndex >= 0 && currentIndex < succeededJobs.length - 1 ? 1 : 0.3 }}
          title="下一个"
        >
          <Icon name="skip-forward" size={16} />
        </button>
        <span style={{ flex: 1, textAlign: 'right', marginRight: 8 }}>
          {currentJobId ? `分镜 ${currentIndex + 1} / ${succeededJobs.length}` : ''}
        </span>
        {videoUrl && (
          <button onClick={onClose} title="关闭预览">
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
