import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/batch-production/assets/import/route.ts', 'utf8');

assert.match(route, /runtime\s*=\s*'nodejs'/);
assert.match(route, /dynamic\s*=\s*'force-dynamic'/);
assert.match(route, /assertBatchApiReady/);
assert.match(route, /registerManagedCopy/);
assert.match(route, /formData\.getAll\('files'\)/);
assert.match(route, /searchParams\.get\('projectId'\)/);
assert.match(route, /project_not_found/);
assert.match(route, /MAX_FILE_COUNT/);
assert.match(route, /MAX_FILE_BYTES/);
assert.match(route, /rm\(/);
assert.match(route, /不支持|MP4|MOV|AVI|WebM/);
assert.match(route, /BATCH_NO_STORE_HEADERS/);

console.log('batch media import route contract tests passed');
