import type { PreviewAudioClip, PreviewAudioMedia } from '../../lib/media-core/preview-audio-timeline.ts';
import type { AudioGainPoint } from '../../lib/media-core/audio-edges';
import { schedulePreviewAudioGain } from './preview-audio-output';
import { createPreviewAudioStart } from './preview-audio-start';

/** 声音始终读取受控原文件，视频代理只参与画面播放。 */
export function createPreviewAudioMedia(clip: PreviewAudioClip, container: HTMLElement,
  getContext: () => AudioContext | null, getOutput?: () => AudioNode | null): PreviewAudioMedia {
  const audio = document.createElement('audio');
  audio.preload = 'auto'; audio.src = clip.url;
  audio.dataset.timelineAudio = clip.id;
  audio.setAttribute('aria-label', `${clip.kind === 'source' ? '原声' : '配音'} ${clip.id}`);
  let gainNode: GainNode | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let start: ReturnType<typeof createPreviewAudioStart> | null = null;
  let disposed = false;
  const setGain = (gain: number, automation?: AudioGainPoint[]) => {
    if (disposed) return;
    const context = getContext();
    if (context && context.state !== 'closed' && !gainNode) {
      gainNode = context.createGain(); source = context.createMediaElementSource(audio);
      start = createPreviewAudioStart(context, audio);
      source.connect(start.node).connect(gainNode).connect(getOutput?.() ?? context.destination); audio.volume = 1;
    }
    if (gainNode && context) schedulePreviewAudioGain(gainNode, context, gain, automation);
    else audio.volume = Math.min(1, Math.max(0, gain));
  };
  const dispose = () => {
    if (disposed) return;
    setGain(0); audio.pause(); disposed = true;
    source?.disconnect(); start?.dispose(); gainNode?.disconnect();
    audio.removeAttribute('src'); audio.load(); audio.remove();
  };
  container.appendChild(audio);
  return Object.assign(audio, { setGain, dispose });
}
