import { AUDIO_EDGE_FADE_US } from '../../lib/media-core/audio-edges';

const preparations = new WeakMap<AudioContext, Promise<void>>();
const processorName = 'formula-audio-start';
// MediaElement decoding and AudioContext automation start on different clocks.
// Count actual incoming samples so the fade cannot expire while decoding waits.
const processor = `class FormulaAudioStart extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.length = options.processorOptions.fadeSamples;
    this.position = 0;
    this.started = false;
    this.port.onmessage = () => { this.position = 0; this.started = false; };
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    for (let frame = 0; frame < output[0].length; frame++) {
      if (!this.started && input.some(channel => Math.abs(channel[frame]) > 1e-8)) this.started = true;
      const gain = this.started ? Math.min(1, this.position / this.length) : 0;
      for (let channel = 0; channel < output.length; channel++) output[channel][frame] = (input[channel]?.[frame] ?? 0) * gain;
      if (this.started && this.position < this.length) this.position++;
    }
    return true;
  }
}
registerProcessor('${processorName}', FormulaAudioStart);`;

export function preparePreviewAudioStart(context: AudioContext): Promise<void> {
  let pending = preparations.get(context);
  if (!pending) {
    const url = URL.createObjectURL(new Blob([processor], { type: 'application/javascript' }));
    pending = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    preparations.set(context, pending);
  }
  return pending;
}

/** Call after preparePreviewAudioStart; every resume/seek starts within real samples. */
export function createPreviewAudioStart(context: AudioContext, media: HTMLMediaElement) {
  const node = new AudioWorkletNode(context, processorName, {
    processorOptions: { fadeSamples: Math.max(1, Math.round(context.sampleRate * AUDIO_EDGE_FADE_US / 1e6)) },
  });
  const reset = () => node.port.postMessage('reset');
  const events = ['play', 'pause', 'seeking', 'emptied'] as const;
  for (const event of events) media.addEventListener(event, reset);
  return { node, dispose() {
    for (const event of events) media.removeEventListener(event, reset);
    node.disconnect(); node.port.close();
  } };
}
