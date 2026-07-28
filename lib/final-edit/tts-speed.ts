function assertRate(rate: number, label: string): void {
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error(`${label}必须位于 0.5x～2.0x`);
  if (Math.abs(rate * 10 - Math.round(rate * 10)) > 1e-8) throw new Error(`${label}必须按 0.1x 步进调整`);
}

export function assertTtsSpeed(speed: number): void {
  assertRate(speed, '语速');
}

export function assertNarrationPlaybackRate(playbackRate: number): void {
  assertRate(playbackRate, '音轨倍速');
}
