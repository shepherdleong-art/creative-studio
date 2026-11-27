import type { TtsVoice } from '@/lib/media-core/tts-voice';

let stopCurrentPreview: (() => void) | undefined;

export async function playTtsVoicePreview(providerId: string, voice: TtsVoice, speed: number): Promise<void> {
  let url = voice.previewUrl;
  let objectUrl: string | undefined;
  if (!url) {
    const response = await fetch(`/api/providers/tts/${encodeURIComponent(providerId)}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voice.id, speed }),
    });
    if (response.status === 202) throw new Error('试听正在准备，请稍后再试。');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error || '音色试听失败');
    }
    url = objectUrl = URL.createObjectURL(await response.blob());
  }

  stopCurrentPreview?.();
  const audio = new Audio(url);
  if (voice.previewUrl) audio.playbackRate = speed;
  const stop = () => {
    audio.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (stopCurrentPreview === stop) stopCurrentPreview = undefined;
  };
  stopCurrentPreview = stop;
  audio.addEventListener('ended', stop, { once: true });
  audio.addEventListener('error', stop, { once: true });
  try {
    await audio.play();
  } catch (error) {
    stop();
    if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
  }
}
