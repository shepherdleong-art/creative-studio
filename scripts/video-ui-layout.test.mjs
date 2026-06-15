import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/projects/[id]/page.tsx', import.meta.url), 'utf8');

assert.match(page, /video-generation-shell/, 'video tab should use an app-like shell class');
assert.doesNotMatch(page, /video-generation-section card p-5/, 'video tab should not render as a generic nested card');

assert.match(css, /\.video-workspace\s*{[^}]*display:\s*grid/s, 'video workspace should use explicit grid columns');
assert.match(css, /grid-template-columns:\s*minmax\(300px,\s*340px\)\s*minmax\(620px,\s*1fr\)\s*minmax\(220px,\s*260px\)/s, 'video workspace should reserve a roomy left editor and dominant center preview');
assert.doesNotMatch(css, /left-col\s*{[^}]*max-width:\s*230px/s, 'left video editor must not be capped at 230px');
assert.match(css, /\.video-preview-fit\s*{[^}]*max-width:\s*min\(100%,\s*760px\)/s, 'center preview should be allowed to grow much larger');
assert.match(css, /\.video-workspace\s+\.video-prompt-field\.input-field\s*{[^}]*min-height:\s*150px/s, 'motion prompt textarea should be tall enough for real descriptions');
assert.match(css, /\.video-workspace\s*>\s*\.video-preview-col\s*{[^}]*background:\s*rgba\(255,255,255,\.48\)/s, 'preview column should use a light canvas instead of a black frame');
assert.doesNotMatch(css, /\.video-workspace\s*>\s*\.video-preview-col\s*{[^}]*linear-gradient\(180deg,\s*#2c2c2e,\s*#111113\)/s, 'preview column should not render a dark box around the video');
assert.match(css, /\.stage-controls\s*{[^}]*background:\s*rgba\(255,255,255,\.82\)/s, 'preview controls should use a light glass bar');
