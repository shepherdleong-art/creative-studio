'use client';

import { useCallback, useEffect, useRef } from 'react';
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
  playSignal: number;
  onNavigate: (jobId: string) => void;
  onClose: () => void;
}

const CONTROLS_HEIGHT = 40; // matches .stage-controls flex line height + padding

export default function VideoGenerationPreview({ videoUrl, posterUrl, placeholderText, videoJobs, currentJobId, playSignal, onNavigate, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const succeededJobs = videoJobs.filter((j) => j.status === 'succeeded' && j.filename);
  const currentIndex = currentJobId ? succeededJobs.findIndex((j) => j.id === currentJobId) : -1;

  const applyStageSize = useCallback(() => {
    const shell = shellRef.current;
    const fit = fitRef.current;
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!shell || !fit || !stage) return;

    if (!video || !video.videoWidth || !video.videoHeight) {
      // No active video: let CSS fallback (16:9, full width) take over
      fit.style.width = '';
      stage.style.width = '';
      stage.style.height = '';
      return;
    }

    const naturalAspect = video.videoWidth / video.videoHeight;
    const rect = shell.getBoundingClientRect();
    const availableW = rect.width;
    const availableH = Math.max(160, rect.height - CONTROLS_HEIGHT);
    const containerAspect = availableW / availableH;

    let w: number;
    let h: number;
    if (naturalAspect >= containerAspect) {
      w = availableW;
      h = availableW / naturalAspect;
    } else {
      h = availableH;
      w = availableH * naturalAspect;
    }

    const roundedW = Math.floor(w);
    const roundedH = Math.floor(h);
    fit.style.width = `${roundedW}px`;
    stage.style.width = `${roundedW}px`;
    stage.style.height = `${roundedH}px`;
  }, []);

  // Play when video or playSignal changes
  useEffect(() => {
    if (!videoUrl || !videoRef.current) return;
    const video = videoRef.current;
    video.currentTime = 0;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // Browser autoplay policy may block — controls remain visible
      });
    }
  }, [videoUrl, currentJobId, playSignal]);

  // Recompute fit when the video source changes or the shell resizes
  useEffect(() => {
    if (!shellRef.current) return;
    applyStageSize();
    const ro = new ResizeObserver(applyStageSize);
    ro.observe(shellRef.current);
    return () => ro.disconnect();
  }, [videoUrl, applyStageSize]);

  return (
    <div ref={shellRef} className="video-preview-shell">
      <div ref={fitRef} className="video-preview-fit">
        <div ref={stageRef} className="video-stage">
          {videoUrl ? (
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              poster={posterUrl || undefined}
              controls
              autoPlay
              playsInline
              className="video-player"
              onLoadedMetadata={applyStageSize}
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
    </div>
  );
}
