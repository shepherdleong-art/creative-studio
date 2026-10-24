/**
 * Match browser mono speaker upmix: duplicate at the original level, keep stereo unchanged.
 *
 * Two FFmpeg quirks force a channel-count split instead of the earlier single
 * `nb_channels` conditional:
 * - FFmpeg ≥7 removed the `aresample=ocl=` option, so a version-portable chain
 *   cannot rely on it.
 * - `aformat=channel_layouts=stereo` upmixes mono with the -3dB energy-preserving
 *   rule. It also negotiates the layout *before* `volume` runs, so
 *   `nb_channels` already reports 2 and the sqrt(2) compensation never fires.
 *   FFmpeg 6 (the bundled ffmpeg-static) and 9 (Homebrew) differ in when that
 *   negotiation happens, so the same chain measured 3dB apart on the two builds.
 *
 * `pan` writes the mapping explicitly, so it neither attenuates the mono upmix
 * nor distorts an existing stereo pair. Which mapping is correct depends on the
 * source channel count, which the caller knows from probing the input.
 */

/** Mono source: duplicate the single channel into both outputs at its own level. */
export const MONO_TO_STEREO_FILTER = 'pan=stereo|c0=c0|c1=c0';

/** Stereo (or wider) source: hard-map the first two channels without touching gain. */
export const STEREO_PASSTHROUGH_FILTER = 'pan=stereo|c0=c0|c1=c1';

/** Choose the upmix that preserves level, given the probed source channel count. */
export function formulaStereoFilter(channels?: number | null): string {
  return channels === 1 ? MONO_TO_STEREO_FILTER : STEREO_PASSTHROUGH_FILTER;
}
