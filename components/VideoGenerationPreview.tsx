'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

const CONTROLS_HEIGHT = 60;

function formatTime(s: number): string {
  if (!isFinite(s) || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function VideoGenerationPreview({ videoUrl, posterUrl, placeholderText, videoJobs, currentJobId, playSignal, onNavigate, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const succeededJobs = videoJobs.filter((j) => j.status === 'succeeded' && j.filename);
  const currentIndex = currentJobId ? succeededJobs.findIndex((j) => j.id === currentJobId) : -1;

  const applyStageSize = useCallback(() => {
    const shell = shellRef.current;
    const player = playerRef.current;
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!shell || !player || !stage) return;

    if (!video || !video.videoWidth || !video.videoHeight) {
      player.style.width = '';
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

    player.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(h)}px`;
  }, []);

  useEffect(() => {
    if (!videoUrl || !videoRef.current) return;
    const video = videoRef.current;
    video.currentTime = 0;
    setCurrentTime(0);
    setIsMuted(false);
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {});
    }
  }, [videoUrl, currentJobId, playSignal]);

  useEffect(() => {
    if (!shellRef.current) return;
    applyStageSize();
    const ro = new ResizeObserver(applyStageSize);
    ro.observe(shellRef.current);
    return () => ro.disconnect();
  }, [videoUrl, applyStageSize]);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const t = Number(e.target.value);
    video.currentTime = t;
    setCurrentTime(t);
  }, []);

  const handleMuteToggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  const resetPlaybackState = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
      video.muted = false;
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsMuted(false);
    if (playerRef.current) playerRef.current.style.width = '';
    if (stageRef.current) stageRef.current.style.height = '';
  }, []);

  const handleClose = useCallback(() => {
    resetPlaybackState();
    onClose();
  }, [onClose, resetPlaybackState]);

  const displayCurrentTime = videoUrl ? currentTime : 0;
  const displayDuration = videoUrl ? duration : 0;
  const displayIsPlaying = Boolean(videoUrl && isPlaying);
  const displayIsMuted = Boolean(videoUrl && isMuted);
  const progressPct = displayDuration > 0 ? `${(displayCurrentTime / displayDuration) * 100}%` : '0%';

  return (
    <div ref={shellRef} className="video-preview-shell">
      <div ref={fitRef} className="video-preview-fit">
        <div ref={playerRef} className="video-player-wrap">
        <div ref={stageRef} className="video-stage">
          {videoUrl ? (
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              poster={posterUrl || undefined}
              playsInline
              className="video-player"
              onLoadStart={() => {
                setIsPlaying(false);
                setCurrentTime(0);
                setDuration(0);
                setIsMuted(false);
              }}
              onLoadedMetadata={applyStageSize}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
              onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
            />
          ) : (
            <div className="stage-placeholder">
              <Icon name="video" size={40} />
              <span>{placeholderText}</span>
            </div>
          )}
        </div>

        <div className="stage-controls">
          {/* Far left: prev */}
          <button
            onClick={() => { if (currentIndex > 0) onNavigate(succeededJobs[currentIndex - 1].id); }}
            disabled={currentIndex <= 0}
            title="上一个"
            className="sc-step-btn"
          >
            <Icon name="skip-back" size={14} />
          </button>

          {/* Play + timeline */}
          <button onClick={handlePlayPause} disabled={!videoUrl} title={displayIsPlaying ? '暂停' : '播放'} className="sc-play-btn">
            <Icon name={displayIsPlaying ? 'pause' : 'play'} size={14} />
          </button>
          <span className="sc-time">{formatTime(displayCurrentTime)}</span>
          <div className="sc-progress-wrap">
            <input
              type="range"
              className="sc-progress"
              style={{ '--pct': progressPct } as React.CSSProperties}
              min={0}
              max={displayDuration || 1}
              step={0.01}
              value={displayCurrentTime}
              onChange={handleSeek}
              disabled={!videoUrl}
            />
          </div>
          <span className="sc-time">{formatTime(displayDuration)}</span>

          {/* Right: meta + volume + close */}
          <div className="sc-right">
            {currentJobId && succeededJobs.length > 1 && (
              <span className="sc-shot-label">{`${currentIndex + 1}/${succeededJobs.length}`}</span>
            )}
            <button onClick={handleMuteToggle} disabled={!videoUrl} title={displayIsMuted ? '取消静音' : '静音'} className="sc-icon-btn">
              {displayIsMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 010 7.07" />
                  <path d="M19.07 4.93a10 10 0 010 14.14" />
                </svg>
              )}
            </button>
            {videoUrl && (
              <button onClick={handleClose} title="关闭预览" className="sc-icon-btn">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>

          {/* Far right: next */}
          <button
            onClick={() => { if (currentIndex >= 0 && currentIndex < succeededJobs.length - 1) onNavigate(succeededJobs[currentIndex + 1].id); }}
            disabled={currentIndex < 0 || currentIndex >= succeededJobs.length - 1}
            title="下一个"
            className="sc-step-btn"
          >
            <Icon name="skip-forward" size={14} />
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
