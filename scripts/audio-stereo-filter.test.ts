import assert from 'node:assert/strict';
import { formulaStereoFilter, MONO_TO_STEREO_FILTER, STEREO_PASSTHROUGH_FILTER } from '../lib/media-core/audio-stereo.ts';

// The upmix has to preserve level, which FFmpeg's own mono→stereo conversion
// does not: aformat attenuates 3dB and negotiates the layout before `volume`
// can read nb_channels, so the conditional sqrt(2) silently stopped applying on
// the bundled FFmpeg 6 build. Pick the mapping from the probed channel count
// instead, and never guess in the mono direction.
assert.equal(formulaStereoFilter(1), MONO_TO_STEREO_FILTER, '单声道必须复制到左右两声道');
assert.equal(formulaStereoFilter(2), STEREO_PASSTHROUGH_FILTER, '立体声必须原样保留左右差异');

// An unknown count must not silently duplicate channel 0 into both sides; that
// would destroy a real stereo pair's separation.
for (const unknown of [0, null, undefined, Number.NaN]) {
  assert.equal(formulaStereoFilter(unknown), STEREO_PASSTHROUGH_FILTER, `无法探测声道数时应保守保留原声道: ${unknown}`);
}

// The mono mapping adds no gain and references only channel 0, so the browser
// preview and the render keep the same level.
assert(!/volume|sqrt/.test(MONO_TO_STEREO_FILTER), '单声道映射不能再叠加增益，电平由源决定');
assert(!/volume|sqrt/.test(STEREO_PASSTHROUGH_FILTER), '立体声映射不能改变电平');

console.log('audio stereo: mono duplicate, stereo passthrough, unknown conservatism passed');
