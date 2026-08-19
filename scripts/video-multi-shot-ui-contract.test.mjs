import assert from 'node:assert/strict';
import fs from 'node:fs';

const providerRoute = fs.readFileSync('app/api/providers/video/route.ts', 'utf8');
const providerItemRoute = fs.readFileSync('app/api/providers/video/[id]/route.ts', 'utf8');
const panel = fs.readFileSync('components/VideoGenerationPanel.tsx', 'utf8');
const motionState = fs.readFileSync('components/video-tail-frame-state.ts', 'utf8');

for (const [label, route] of [
  ['provider collection', providerRoute],
  ['provider item', providerItemRoute],
]) {
  assert.match(route, /video-multi-shot/, `${label} must use the shared multi-shot capability predicate`);
  assert.match(route, /isCompanyKlingMultiShotTarget/, `${label} must check the exact company Kling model`);
  assert.match(route, /multiShotCapability/, `${label} must expose multiShotCapability for the managed row`);
  assert.match(
    route,
    /supported:\s*true[\s\S]*defaultEnabled:\s*true/,
    `${label} must advertise the managed capability as supported and enabled by default`,
  );
  assert.doesNotMatch(
    route,
    /multiShotCapability\s*:\s*\{\s*supported\s*:\s*false/,
    `${label} must omit unsupported capability placeholders instead of returning false`,
  );
}

assert.match(
  panel,
  /multiShotCapability\?:\s*\{\s*supported:\s*boolean;\s*defaultEnabled:\s*boolean;\s*\}/,
  'the panel provider type must carry the optional multi-shot capability',
);
assert.match(
  motionState,
  /multiShot:\s*boolean/,
  'video motion rows must carry the multi-shot toggle state',
);
assert.match(
  motionState,
  /multiShot:\s*true/,
  'new motion rows must default the multi-shot toggle on',
);

const batchItemsStart = panel.indexOf('const items = motionRows');
const batchItemsEnd = panel.indexOf("if (items.length === 0)", batchItemsStart);
assert.notEqual(batchItemsStart, -1, 'the panel must build batch items from motion rows');
assert.notEqual(batchItemsEnd, -1, 'the panel must validate the batch items');
const batchItems = panel.slice(batchItemsStart, batchItemsEnd);
assert.match(
  batchItems,
  /\.\.\.\s*\(\s*getRowMultiShotCapability\(r\)\?\.supported\s*===\s*true\s*\?\s*\{\s*multiShot:\s*r\.multiShot\s*\}\s*:\s*\{\}\s*\)/,
  'batch payloads must include multiShot only for providers advertising support',
);

const motionRenderStart = panel.indexOf('{motionRows.map((row, idx) => {');
const motionRenderEnd = panel.indexOf('removeMotionRow(row.key)', motionRenderStart);
assert.notEqual(motionRenderStart, -1, 'the panel must render each motion row');
assert.notEqual(motionRenderEnd, -1, 'the panel must keep the row controls in the render block');
const motionRender = panel.slice(motionRenderStart, motionRenderEnd);
assert.match(
  motionRender,
  /const multiShotCapability\s*=\s*getRowMultiShotCapability\(row\)/,
  'multi-shot visibility must use the current row provider capability',
);
assert.match(
  motionRender,
  /multiShotCapability\?\.supported\s*===\s*true\s*&&\s*\([\s\S]*role="switch"[\s\S]*aria-checked=\{row\.multiShot\}[\s\S]*onClick=/,
  'supported rows must render a controlled 智能分镜 switch',
);
assert.match(motionRender, /智能分镜/, 'the switch must be labeled in Chinese');
assert.match(
  motionRender,
  /grid-cols-\[1fr_72px_auto\][\s\S]*模板（可选）[\s\S]*秒数[\s\S]*role="switch"/,
  'the switch must sit in the same control row as template and duration',
);
assert.doesNotMatch(
  motionRender,
  /type="checkbox"[\s\S]{0,200}智能分镜|智能分镜[\s\S]{0,200}type="checkbox"/,
  'the toggle must not fall back to a bare checkbox',
);
assert.doesNotMatch(
  motionRender,
  /暂不支持智能分镜|智能分镜不可用|is-disabled[\s\S]{0,120}智能分镜/,
  'unsupported providers must not render a grey multi-shot placeholder',
);

console.log('video multi-shot UI/provider capability contract tests passed');
