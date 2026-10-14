export type Point = [number, number];
export interface Shot {
  id: string;
  file: string;
  startFrame: number;
  endFrame: number;
  inSec: number;
  rate: number;
}
export interface Subtitle { text: string; startFrame: number; endFrame: number }
export interface Callout {
  id: string;
  shot: string;
  startFrame: number;
  endFrame: number;
  title: string;
  sub?: string;
  dot: Point;
  pill: Point;
  box?: Point;
  dotKeyframes?: { frame: number; dot: Point }[];
}
export interface Voice { file: string; trimStart: number; trimEnd: number; atFrame: number }
export interface FilmAudio {
  voices: Voice[];
  music: {
    file: string;
    gainDb: number;
    fadeInSec: number;
    fadeOutSec: number;
    ducking: { threshold: number; ratio: number; attackMs: number; releaseMs: number };
  };
  loudness: { integratedLufs: number; truePeakDb: number; lra: number };
}
export interface ClassicConfig {
  projectCss: string;
  designDoc: string;
  theme: string;
  /** Python renders integer 20 and float 20.0 differently in the root HTML attribute. */
  durationText?: string;
  cover: {
    image: string;
    title: [string, string];
    tag: string;
    note: string;
    brand: string;
    model: string;
    productName: string;
  };
  labels: Record<string, [string, string, string, string]>;
  callouts: Callout[];
  outro: { title: [string, string] };
}
export interface RenderSpec {
  schemaVersion: 1;
  project: { root: string; variant: string; baseName: string };
  canvas: { width: 1080; height: 1440; fps: 24; introFrames: 20; frames: number };
  template: { id: 'classic'; version: '1' };
  shots: Shot[];
  subtitles: Subtitle[];
  audio: FilmAudio;
  classic: ClassicConfig;
  output: { coverFrame: number };
}
export type ClassicComposition = Pick<RenderSpec, 'project' | 'canvas' | 'shots' | 'subtitles' | 'classic'>;
