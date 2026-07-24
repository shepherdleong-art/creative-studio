export function assertTtsSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('语速必须位于 0.5x～2.0x');
  if (Math.abs(speed * 10 - Math.round(speed * 10)) > 1e-8) throw new Error('语速必须按 0.1x 步进调整');
}
