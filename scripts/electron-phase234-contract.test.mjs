import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const main = read('desktop/main.ts');
const windowSource = read('desktop/window.ts');
const serviceSpawn = read('desktop/service-spawn.ts');
const serviceReady = read('desktop/service-ready.ts');
const serviceShutdown = read('desktop/service-shutdown.ts');
const serviceState = read('desktop/service-state.ts');
const materials = read('components/batch-production/BatchStepMaterials.tsx');
const importRoute = read('app/api/desktop/import-linked/route.ts');
const activityRoute = read('app/api/desktop/activity/route.ts');
const relocateRoute = read('app/api/desktop/relocate-linked/route.ts');

// Phase 2: native selection never returns an absolute path to renderer code.
assert.match(windowSource, /dialog\.showOpenDialog\(window/);
assert.match(windowSource, /properties: \['openFile', 'multiSelections'\]/);
assert.match(windowSource, /properties: \['openDirectory'\]/);
assert.match(windowSource, /x-creative-studio-desktop-secret/);
assert.match(windowSource, /return \{ requestId, count \}/);
assert.match(windowSource, /filePaths: \[filePaths\[index\]\]/);
assert.match(windowSource, /linkedImportProgress/);
assert.match(windowSource, /completed: index \+ 1/);
assert.match(windowSource, /total: filePaths\.length/);
assert.match(read('desktop/preload.ts'), /total <= 500/);
assert.doesNotMatch(windowSource, /chooseMediaFiles:[\s\S]{0,1200}return\s+filePaths/);
assert.match(importRoute, /process\.env\.CREATIVE_STUDIO_DESKTOP !== '1'/);
assert.match(importRoute, /CREATIVE_STUDIO_DESKTOP_SECRET/);
assert.match(importRoute, /timingSafeEqual/);
assert.match(importRoute, /registerLinkedSource/);
assert.match(importRoute, /isAbsolute/);
assert.match(importRoute, /status: 403/);
assert.match(activityRoute, /CREATIVE_STUDIO_DESKTOP_SECRET/);
assert.match(activityRoute, /status: 403/);
assert.match(relocateRoute, /process\.env\.CREATIVE_STUDIO_DESKTOP !== '1'/);
assert.match(relocateRoute, /timingSafeEqual/);
assert.match(relocateRoute, /isAbsolute/);
assert.match(relocateRoute, /assertBatchApiReady/);
assert.match(relocateRoute, /relocateLinkedSource/);
assert.match(relocateRoute, /status: 403/);
assert.match(windowSource, /relocateLinkedSource/);
assert.match(main, /app\.getPath\('appData'\), 'CreativeStudio'/);
assert.match(materials, /正在校验/);
assert.match(materials, /removeEventListener\('creative-studio:linked-import-progress'/);

// The native import controls belong only to the batch materials step.
assert.match(materials, /从本机选择原片（不复制）/);
assert.match(materials, /chooseMediaFiles/);
assert.match(materials, /chooseFolder/);
assert.ok(fs.existsSync('components/mixcut/MaterialStep.tsx'));
assert.doesNotMatch(read('components/mixcut/MaterialStep.tsx'), /chooseMediaFiles|chooseFolder/);

// Phase 3: close hides; explicit quit owns shutdown; descendants are reaped.
assert.match(windowSource, /window\.hide\(\)/);
assert.match(windowSource, /首次|仍在运行/);
assert.match(main, /app\.on\('before-quit'/);
assert.match(main, /confirmQuitAndShutdown/);
assert.doesNotMatch(main, /app\.on\('window-all-closed',[\s\S]{0,300}app\.quit\(\)/);
assert.match(serviceSpawn, /detached: process\.platform !== 'win32'/);
assert.match(serviceShutdown, /process\.kill\(-pid, signal\)/);
assert.match(serviceShutdown, /taskkill\.exe/);
assert.match(serviceShutdown, /'\/T', '\/F'/);
assert.match(serviceState, /electron-service\.json/);
assert.match(serviceState, /persistServiceState/);
assert.match(serviceState, /clearServiceState/);
// The ready/health handshake stays in the dedicated service-ready module.
assert.match(serviceReady, /READY_PREFIX/);
assert.match(serviceReady, /api\/desktop\/health/);

console.log('electron phase 2-4 contract tests passed');
