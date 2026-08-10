import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const main = read('desktop/main.ts');
const service = read('desktop/service.ts');
const materials = read('components/batch-production/BatchStepMaterials.tsx');
const importRoute = read('app/api/desktop/import-linked/route.ts');
const activityRoute = read('app/api/desktop/activity/route.ts');

// Phase 2: native selection never returns an absolute path to renderer code.
assert.match(main, /dialog\.showOpenDialog\(window/);
assert.match(main, /properties: \['openFile', 'multiSelections'\]/);
assert.match(main, /properties: \['openDirectory'\]/);
assert.match(main, /x-creative-studio-desktop-secret/);
assert.match(main, /return \{ requestId: randomUUID\(\), count: payload\.assetIds\.length \}/);
assert.doesNotMatch(main, /chooseMediaFiles:[\s\S]{0,1200}return\s+filePaths/);
assert.match(importRoute, /process\.env\.CREATIVE_STUDIO_DESKTOP !== '1'/);
assert.match(importRoute, /CREATIVE_STUDIO_DESKTOP_SECRET/);
assert.match(importRoute, /timingSafeEqual/);
assert.match(importRoute, /registerLinkedSource/);
assert.match(importRoute, /isAbsolute/);
assert.match(importRoute, /status: 403/);
assert.match(activityRoute, /CREATIVE_STUDIO_DESKTOP_SECRET/);
assert.match(activityRoute, /status: 403/);
assert.match(main, /app\.getPath\('appData'\), 'CreativeStudio'/);

// The native import controls belong only to the batch materials step.
assert.match(materials, /从本机选择原片（不复制）/);
assert.match(materials, /chooseMediaFiles/);
assert.match(materials, /chooseFolder/);
assert.ok(fs.existsSync('components/mixcut/MaterialStep.tsx'));
assert.doesNotMatch(read('components/mixcut/MaterialStep.tsx'), /chooseMediaFiles|chooseFolder/);

// Phase 3: close hides; explicit quit owns shutdown; descendants are reaped.
assert.match(main, /window\.hide\(\)/);
assert.match(main, /首次|仍在运行/);
assert.match(main, /app\.on\('before-quit'/);
assert.match(main, /confirmQuitAndShutdown/);
assert.doesNotMatch(main, /app\.on\('window-all-closed',[\s\S]{0,300}app\.quit\(\)/);
assert.match(service, /detached: process\.platform !== 'win32'/);
assert.match(service, /process\.kill\(-pid, signal\)/);
assert.match(service, /taskkill\.exe/);
assert.match(service, /'\/T', '\/F'/);

console.log('electron phase 2-4 contract tests passed');
