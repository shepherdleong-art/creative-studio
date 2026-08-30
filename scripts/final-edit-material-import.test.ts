import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import { importShotSetExternalAssetsFromFormData } from '../lib/final-edit/material-import-http.ts';
import { createFinalEditWorkspace, FinalEditError } from '../lib/final-edit/workspace.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-material-import-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE shots (id TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, indexNum INTEGER NOT NULL);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT NOT NULL, path TEXT NOT NULL);
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT, shotId TEXT,
    status TEXT NOT NULL, localVideoPath TEXT, filename TEXT, durationSec INTEGER
  );
`);
initFinalEditSchema(db);

const artifactColumns = db.prepare(`PRAGMA table_info(project_artifacts)`).all() as Array<{ name: string }>;
assert.deepEqual(artifactColumns.map((column) => column.name), [
  'id', 'projectId', 'kind', 'displayName', 'relativePath', 'mimeType', 'sourceJobId', 'createdAt',
], 'final-edit schema 必须创建真实项目产物表');
const artifactIndexes = db.prepare(`PRAGMA index_list(project_artifacts)`).all() as Array<{ name: string; unique: number }>;
assert.ok(artifactIndexes.some((index) => index.name === 'idx_project_artifacts_project'));
assert.ok(artifactIndexes.some((index) => index.name === 'idx_project_artifacts_source_kind' && index.unique === 1));

const columns = db.prepare(`PRAGMA table_info(final_edit_external_assets)`).all() as Array<{ name: string }>;
assert.deepEqual(columns.map((column) => column.name), [
  'id', 'projectId', 'shotSetId', 'originalFilename', 'relativePath',
  'thumbnailRelativePath', 'mimeType', 'mediaKind', 'durationUs', 'width',
  'height', 'fileFingerprint', 'status', 'errorMessage', 'createdAt',
]);
const externalAssetIndexes = db.prepare(`PRAGMA index_list(final_edit_external_assets)`).all() as Array<{ name: string; unique: number }>;
assert.ok(externalAssetIndexes.some((index) => index.name === 'idx_final_edit_external_assets_group'));
assert.ok(externalAssetIndexes.some((index) => index.unique === 1), 'shotSetId+fileFingerprint must have a unique index');

db.prepare(`INSERT INTO projects (id, name) VALUES ('project-a', '项目 A'), ('project-b', '项目 B')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES
  ('set-a', 'project-a', '分镜 A'),
  ('set-b', 'project-a', '分镜 B'),
  ('set-pre', 'project-a', '尚未创建成片组的分镜'),
  ('set-concurrent', 'project-a', '并发导入'),
  ('set-race', 'project-a', '混合并发导入'),
  ('set-formats', 'project-a', '格式覆盖'),
  ('set-gif', 'project-a', 'GIF 转码'),
  ('set-invalid', 'project-a', '失败素材'),
  ('set-symlink', 'project-a', '路径安全'),
  ('set-c', 'project-b', '分镜 C')
`).run();

function insertGroup(id: string, projectId: string, shotSetId: string) {
  db.prepare(`
    INSERT INTO final_edit_groups (
      id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash,
      narrationConfigJson, coverTitleJson, textStylesJson, status, phase, revision,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, '{}', ?, '{}', '{}', '{}', 'ready', 'ready', 0, ?, ?)
  `).run(id, projectId, `draft-${id}`, shotSetId, `hash-${id}`, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
}
insertGroup('group-a', 'project-a', 'set-a');
insertGroup('group-b', 'project-a', 'set-b');
insertGroup('group-c', 'project-b', 'set-c');

const sourceVideo = path.join(root, 'source.mp4');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x240:rate=24',
  '-pix_fmt', 'yuv420p', '-y', sourceVideo,
]);
const sourceBytes = fs.readFileSync(sourceVideo);

const formatUploads: Array<{ filename: string; mimeType: string; data: Buffer }> = [];
for (const format of [
  { extension: 'mov', mimeType: 'video/quicktime', args: ['-c:v', 'mpeg4', '-f', 'mov'] },
  { extension: 'avi', mimeType: 'video/x-msvideo', args: ['-c:v', 'mpeg4', '-f', 'avi'] },
  { extension: 'webm', mimeType: 'video/webm', args: ['-c:v', 'libvpx-vp9', '-f', 'webm'] },
]) {
  const target = path.join(root, `source.${format.extension}`);
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=0.4:size=160x120:rate=12', ...format.args, '-y', target]);
  formatUploads.push({ filename: path.basename(target), mimeType: format.mimeType, data: fs.readFileSync(target) });
}
const gifPath = path.join(root, 'animated.gif');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=160x120:rate=12',
  '-vf', 'fps=12', '-f', 'gif', '-y', gifPath,
]);

// The public HTTP seam must consume real multipart bytes. Ownership-looking
// client fields are deliberately present but must not be returned/used.
const form = new FormData();
form.set('projectId', 'project-b');
form.set('shotSetId', 'set-c');
form.append('files', new File([sourceBytes], '../../client-name.mp4', { type: 'video/mp4' }));
let stagedUploadPath = '';
const parsedResult = await importShotSetExternalAssetsFromFormData(
  new Request('http://local/import', { method: 'POST', body: form }),
  async (files) => {
    assert.equal(files.length, 1, 'multipart uploads must be processed one file at a time');
    assert.equal(files[0].filename, '../../client-name.mp4');
    assert.ok('temporaryPath' in files[0], 'HTTP uploads should be staged to disk instead of retained as batch Buffers');
    stagedUploadPath = files[0].temporaryPath;
    assert.deepEqual(fs.readFileSync(stagedUploadPath), sourceBytes, 'FormData bytes must be streamed without JSON conversion');
    return { assets: [], errors: [] };
  },
);
assert.deepEqual(parsedResult, { assets: [], errors: [] });
assert.equal(fs.existsSync(stagedUploadPath), false, 'staged request files must be cleaned after processing');
const failingForm = new FormData();
failingForm.append('files', new File([sourceBytes], 'cleanup.mp4', { type: 'video/mp4' }));
let failedStagedPath = '';
await assert.rejects(
  () => importShotSetExternalAssetsFromFormData(
    new Request('http://local/import', { method: 'POST', body: failingForm }),
    async (files) => {
      failedStagedPath = 'temporaryPath' in files[0] ? files[0].temporaryPath : '';
      throw new FinalEditError('shot_set_not_found', '测试请求级失败', 404);
    },
  ),
  (error: unknown) => error instanceof FinalEditError && error.code === 'shot_set_not_found',
);
assert.equal(fs.existsSync(failedStagedPath), false, 'request-level failures must clean staged bytes');
const parsedForm = {
  files: [{ filename: '../../client-name.mp4', mimeType: 'video/mp4', data: sourceBytes }],
};

const workspace = createFinalEditWorkspace({
  db,
  storageRoot,
  probeVideo: async ({ filePath }) => probeVideoMedia(filePath),
  analyzeVideo: async () => ({ summary: '', sellingPoints: [], semanticTags: [], usableRanges: [], qualityIssues: [], coverFrameTimesUs: [] }),
  synthesize: async () => ({ relativePath: '', durationUs: 0, segmentTimings: [], wordTimings: [] }),
});

// On Apple Silicon the bundled ffprobe may be unusable. The async ffmpeg
// fallback still has to recover real duration and dimensions.
const fakeFfprobe = path.join(root, 'not-executable-ffprobe');
fs.writeFileSync(fakeFfprobe, 'not executable');
const previousFfprobe = process.env.CREATIVE_STUDIO_FFPROBE;
process.env.CREATIVE_STUDIO_FFPROBE = fakeFfprobe;
const directProbe = await probeVideoMedia(sourceVideo);
if (previousFfprobe === undefined) delete process.env.CREATIVE_STUDIO_FFPROBE;
else process.env.CREATIVE_STUDIO_FFPROBE = previousFfprobe;
assert.ok(Math.abs(directProbe.durationUs - 1_000_000) < 200_000, `durationUs=${directProbe.durationUs}`);
assert.equal(directProbe.width, 320);
assert.equal(directProbe.height, 240);
assert.ok((directProbe.format || '').includes('mp4'));

// Canonical Step-1 path: import by verified project+shotSet ownership before
// any final_edit_group exists, with no invented scriptDraftId/group/revision.
const preGroupForm = new FormData();
preGroupForm.set('projectId', 'project-b');
preGroupForm.set('shotSetId', 'set-c');
preGroupForm.append('files', new File([sourceBytes], 'pre-group.mp4', { type: 'video/mp4' }));
const preGroup = await importShotSetExternalAssetsFromFormData(
  new Request('http://local/import', { method: 'POST', body: preGroupForm }),
  (files) => workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-pre', files }),
);
assert.equal(preGroup.assets.length, 1);
assert.equal(preGroup.assets[0].projectId, 'project-a');
assert.equal(preGroup.assets[0].shotSetId, 'set-pre');
assert.ok(preGroup.assets[0].previewUrl.startsWith('/api/projects/project-a/final-edit/shot-sets/set-pre/external-assets/'));
assert.equal(db.prepare(`SELECT 1 FROM final_edit_groups WHERE shotSetId='set-pre'`).get(), undefined, 'import must not manufacture a placeholder group');
assert.throws(
  () => workspace.resolveShotSetExternalAssetMedia('project-b', 'set-c', preGroup.assets[0].id, 'video'),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_not_found',
);
assert.equal(workspace.deleteShotSetExternalAsset({ projectId: 'project-a', shotSetId: 'set-pre', assetId: preGroup.assets[0].id }).deleted, true);

const [concurrentA, concurrentB] = await Promise.all([
  workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-concurrent', files: parsedForm.files }),
  workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-concurrent', files: parsedForm.files }),
]);
assert.equal(concurrentA.assets[0].id, concurrentB.assets[0].id, 'concurrent duplicate imports must converge on one row');
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_external_assets WHERE shotSetId='set-concurrent'`).get() as { count: number }).count, 1);
assert.equal(fs.readdirSync(path.join(storageRoot, 'final-edits', 'projects', 'project-a', 'groups', 'set-concurrent', 'materials')).length, 1);

let notifySlowFileStarted: () => void = () => {};
const slowFileStarted = new Promise<void>((resolve) => { notifySlowFileStarted = resolve; });
const raceWorkspace = createFinalEditWorkspace({
  db,
  storageRoot,
  probeVideo: async ({ filePath }) => {
    if (path.extname(filePath) === '.mov') {
      notifySlowFileStarted();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return probeVideoMedia(filePath);
  },
  analyzeVideo: async () => ({ summary: '', sellingPoints: [], semanticTags: [], usableRanges: [], qualityIssues: [], coverFrameTimesUs: [] }),
  synthesize: async () => ({ relativePath: '', durationUs: 0, segmentTimings: [], wordTimings: [] }),
});
const mixedBatchPromise = raceWorkspace.importShotSetExternalAssets({
  projectId: 'project-a',
  shotSetId: 'set-race',
  files: [parsedForm.files[0], formatUploads[0]],
});
await slowFileStarted;
const racingDuplicate = await raceWorkspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-race', files: parsedForm.files });
const mixedBatch = await mixedBatchPromise;
assert.equal(mixedBatch.errors.length, 0, JSON.stringify(mixedBatch.errors));
assert.equal(mixedBatch.assets.length, 2, 'a raced duplicate must not roll back the unrelated new file');
assert.ok(mixedBatch.assets.some((asset) => asset.id === racingDuplicate.assets[0].id && asset.reused));
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_external_assets WHERE shotSetId='set-race'`).get() as { count: number }).count, 2);

const formats = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-formats', files: formatUploads });
assert.equal(formats.errors.length, 0, JSON.stringify(formats.errors));
assert.deepEqual(formats.assets.map((asset) => asset.mimeType).sort(), ['video/quicktime', 'video/webm', 'video/x-msvideo']);
assert.ok(formats.assets.every((asset) => asset.status === 'ready' && asset.width === 160 && asset.height === 120));

const gifs = await workspace.importShotSetExternalAssets({
  projectId: 'project-a',
  shotSetId: 'set-gif',
  files: [{ filename: 'animated.gif', mimeType: 'image/gif', data: fs.readFileSync(gifPath) }],
});
assert.equal(gifs.errors.length, 0, JSON.stringify(gifs.errors));
assert.equal(gifs.assets.length, 1);
assert.equal(gifs.assets[0].originalFilename, 'animated.gif', 'GIF 的原始文件名应保留给界面');
assert.equal(gifs.assets[0].mimeType, 'video/mp4', 'GIF 导入后应以 MP4 作为实际媒体类型');
const gifRow = db.prepare(`SELECT relativePath FROM final_edit_external_assets WHERE id=?`).get(gifs.assets[0].id) as { relativePath: string };
assert.equal(path.extname(gifRow.relativePath), '.mp4', 'GIF 不得以 GIF 原格式写入素材库');
assert.ok(fs.existsSync(path.join(storageRoot, gifRow.relativePath)), 'GIF 转码后的 MP4 必须写入素材库');
const gifMedia = await probeVideoMedia(path.join(storageRoot, gifRow.relativePath));
assert.ok((gifMedia.format || '').includes('mp4'));
assert.ok(gifMedia.durationUs > 0);

const invalidGif = await workspace.importShotSetExternalAssets({
  projectId: 'project-a',
  shotSetId: 'set-gif',
  files: [{ filename: 'broken.gif', mimeType: 'image/gif', data: Buffer.from('not a GIF') }],
});
assert.equal(invalidGif.assets.length, 0, 'GIF 转码失败不得返回半成品素材');
assert.equal(invalidGif.errors[0]?.error, 'gif_transcode_failed');
assert.equal(
  db.prepare(`SELECT 1 FROM final_edit_external_assets WHERE originalFilename='broken.gif'`).get(),
  undefined,
  'GIF 转码失败不得写入数据库记录',
);

const abortedGifImport = new AbortController();
abortedGifImport.abort();
await assert.rejects(
  () => workspace.importShotSetExternalAssets({
    projectId: 'project-a',
    shotSetId: 'set-gif',
    files: [{ filename: 'cancelled.gif', mimeType: 'image/gif', data: fs.readFileSync(gifPath) }],
    signal: abortedGifImport.signal,
  }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
  '已取消的 GIF 导入必须在转码前中止且不得落库',
);
assert.equal(
  db.prepare(`SELECT 1 FROM final_edit_external_assets WHERE originalFilename='cancelled.gif'`).get(),
  undefined,
);

const first = await workspace.importShotSetExternalAssets({
  projectId: 'project-a',
  shotSetId: 'set-a',
  files: parsedForm.files,
});
assert.equal(first.errors.length, 0);
assert.equal(first.assets.length, 1);
assert.equal(first.assets[0].projectId, 'project-a', 'server group ownership must override hostile FormData ownership');
assert.equal(first.assets[0].shotSetId, 'set-a');
assert.equal(first.assets[0].assetKey, `external:${first.assets[0].id}`);
assert.equal(first.assets[0].source, 'external');
assert.ok(!('fileFingerprint' in first.assets[0]), 'API read model must not expose the internal file fingerprint');
assert.equal(first.assets[0].originalFilename, 'client-name.mp4');
assert.equal(first.assets[0].status, 'ready');
assert.equal(first.assets[0].width, 320);
assert.equal(first.assets[0].height, 240);
assert.ok(first.assets[0].durationUs > 0);

const firstRow = db.prepare(`SELECT * FROM final_edit_external_assets WHERE id=?`).get(first.assets[0].id) as {
  relativePath: string;
  thumbnailRelativePath: string;
};
const expectedMaterialPrefix = path.join('final-edits', 'projects', 'project-a', 'groups', 'set-a', 'materials') + path.sep;
assert.ok(firstRow.relativePath.startsWith(expectedMaterialPrefix));
assert.ok(fs.existsSync(path.join(storageRoot, firstRow.relativePath)), 'imported video must exist under the group material directory');
assert.ok(fs.existsSync(path.join(storageRoot, firstRow.thumbnailRelativePath)), 'real thumbnail artifact must be materialized');
assert.equal(fs.existsSync(path.join(root, 'client-name.mp4')), false, 'traversal-like original filename must never control the destination');

const tamperedRelativePath = path.join(path.dirname(firstRow.relativePath), 'tampered.txt');
fs.writeFileSync(path.join(storageRoot, tamperedRelativePath), 'not video');
db.prepare(`UPDATE final_edit_external_assets SET relativePath=? WHERE id=?`).run(tamperedRelativePath, first.assets[0].id);
assert.throws(
  () => workspace.resolveShotSetExternalAssetMedia('project-a', 'set-a', first.assets[0].id, 'video'),
  (error: unknown) => error instanceof FinalEditError && error.code === 'unsafe_path',
  'DB path tampering to a non-video extension must be rejected even inside the owner directory',
);
db.prepare(`UPDATE final_edit_external_assets SET relativePath=? WHERE id=?`).run(firstRow.relativePath, first.assets[0].id);
fs.unlinkSync(path.join(storageRoot, tamperedRelativePath));

const duplicate = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-a', files: parsedForm.files });
assert.equal(duplicate.errors.length, 0);
assert.equal(duplicate.assets[0].id, first.assets[0].id);
assert.equal(duplicate.assets[0].reused, true);
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM final_edit_external_assets WHERE shotSetId='set-a'`).get() as { count: number }).count, 1);

fs.unlinkSync(path.join(storageRoot, firstRow.thumbnailRelativePath));
assert.equal(workspace.listShotSetExternalAssets('project-a', 'set-a')[0].status, 'failed', 'missing thumbnail must not remain ready');
const thumbnailRepaired = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-a', files: parsedForm.files });
assert.equal(thumbnailRepaired.assets[0].id, first.assets[0].id);
assert.equal(thumbnailRepaired.assets[0].reused, false);
assert.ok(fs.existsSync(path.join(storageRoot, firstRow.thumbnailRelativePath)));

const crossGroup = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-b', files: parsedForm.files });
assert.equal(crossGroup.errors.length, 0);
assert.notEqual(crossGroup.assets[0].id, first.assets[0].id, 'same bytes in another shot set must be a distinct record');
assert.equal(crossGroup.assets[0].shotSetId, 'set-b');
assert.ok((db.prepare(`SELECT relativePath FROM final_edit_external_assets WHERE id=?`).get(crossGroup.assets[0].id) as { relativePath: string }).relativePath.includes(`${path.sep}set-b${path.sep}`));
assert.deepEqual(workspace.listShotSetExternalAssets('project-a', 'set-a').map((asset) => asset.id), [first.assets[0].id]);
assert.deepEqual(workspace.listShotSetExternalAssets('project-a', 'set-b').map((asset) => asset.id), [crossGroup.assets[0].id]);

assert.throws(
  () => workspace.resolveShotSetExternalAssetMedia('project-a', 'set-b', first.assets[0].id, 'video'),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_not_found',
  'a group must not resolve another group\'s media',
);
assert.throws(
  () => workspace.deleteShotSetExternalAsset({ projectId: 'project-a', shotSetId: 'set-b', assetId: first.assets[0].id }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_not_found',
  'a group must not delete another group\'s asset',
);

// Missing files remain visible as a recoverable state. Re-importing the same
// fingerprint repairs the SAME row instead of silently creating a duplicate.
fs.unlinkSync(path.join(storageRoot, firstRow.relativePath));
assert.equal(workspace.listShotSetExternalAssets('project-a', 'set-a')[0].status, 'missing');
const repaired = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-a', files: parsedForm.files });
assert.equal(repaired.assets[0].id, first.assets[0].id);
assert.equal(repaired.assets[0].reused, false);
assert.ok(fs.existsSync(path.join(storageRoot, firstRow.relativePath)));

const rejectedForm = new FormData();
rejectedForm.append('files', new File([Buffer.from('not an image either')], 'still.png', { type: 'image/png' }));
rejectedForm.append('files', new File([Buffer.from('plain text')], 'notes.txt', { type: 'text/plain' }));
const rejected = await importShotSetExternalAssetsFromFormData(
  new Request('http://local/import', { method: 'POST', body: rejectedForm }),
  (files) => workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-a', files }),
);
assert.equal(rejected.assets.length, 0);
assert.deepEqual(rejected.errors.map((item) => item.error), ['unsupported_media_kind', 'unsupported_video_format']);
await assert.rejects(
  () => importShotSetExternalAssetsFromFormData(
    new Request('http://local/import', { method: 'POST', body: new FormData() }),
    (files) => workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-a', files }),
  ),
  (error: unknown) => error instanceof FinalEditError && error.code === 'files_required',
  'empty multipart requests remain request-level 4xx errors',
);

const spoofedForm = new FormData();
spoofedForm.append('files', new File([sourceBytes], 'spoofed.webm', { type: 'video/webm' }));
const spoofed = await importShotSetExternalAssetsFromFormData(
  new Request('http://local/import', { method: 'POST', body: spoofedForm }),
  (files) => workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-invalid', files }),
);
assert.equal(spoofed.errors[0].error, 'video_format_mismatch');
assert.equal(spoofed.assets.length, 1, 'all-file failures still return a parseable result containing the failed asset');
assert.equal(spoofed.assets[0].status, 'failed', 'probe-stage failures must remain visible after refresh');
assert.equal(workspace.listShotSetExternalAssets('project-a', 'set-invalid')[0].status, 'failed');
assert.throws(
  () => workspace.resolveShotSetExternalAssetMedia('project-a', 'set-invalid', spoofed.assets[0].id, 'video'),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_not_ready',
);

const outside = path.join(root, 'outside');
fs.mkdirSync(outside);
const unsafeMaterials = path.join(storageRoot, 'final-edits', 'projects', 'project-a', 'groups', 'set-symlink');
fs.mkdirSync(unsafeMaterials, { recursive: true });
fs.symlinkSync(outside, path.join(unsafeMaterials, 'materials'));
const unsafeImport = await workspace.importShotSetExternalAssets({ projectId: 'project-a', shotSetId: 'set-symlink', files: parsedForm.files });
assert.equal(unsafeImport.errors[0].error, 'unsafe_path');
assert.deepEqual(fs.readdirSync(outside), [], 'symlinked owner directory must never receive bytes');

const canonicalRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/route.ts'), 'utf8');
assert.match(canonicalRoute, /importShotSetExternalAssetsFromFormData\(/);
assert.match(canonicalRoute, /importShotSetExternalAssets\(\{ projectId, shotSetId, files, signal \}\)/);
assert.doesNotMatch(canonicalRoute, /status === ['"]ready['"]/, 'all-file failures must remain a parseable success response');
assert.doesNotMatch(canonicalRoute, /expectedRevision/, 'pre-group canonical import must not invent revision semantics');
const finalEditSchemaSource = fs.readFileSync(path.join(process.cwd(), 'lib/final-edit/schema.ts'), 'utf8');
assert.doesNotMatch(finalEditSchemaSource, /idx_shots_shotset/, 'core shots indexes must not be owned by final-edit migrations');
const deleteRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/[assetId]/route.ts'), 'utf8');
assert.match(deleteRoute, /deleteShotSetExternalAsset\(\{ projectId, shotSetId, assetId \}\)/);

assert.throws(
  () => workspace.listShotSetExternalAssets('project-a', 'missing-set'),
  (error: unknown) => error instanceof FinalEditError && error.code === 'shot_set_not_found',
);

// Physical deletion is blocked before touching bytes when a draft or project
// artifact references the asset.
db.prepare(`
  INSERT INTO final_edit_variants (
    id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson,
    issuesJson, overlapJson, revision, createdAt, updatedAt
  ) VALUES ('variant-a', 'group-a', 1, '3x4', ?, '{}', '{}', '[]', '{}', 0, ?, ?)
`).run(JSON.stringify({ clips: [{ externalAssetId: first.assets[0].id }] }), '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
assert.throws(
  () => workspace.deleteShotSetExternalAsset({ projectId: 'project-a', shotSetId: 'set-a', assetId: first.assets[0].id }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_in_use',
);
assert.ok(fs.existsSync(path.join(storageRoot, firstRow.relativePath)));
db.prepare(`DELETE FROM final_edit_variants WHERE id='variant-a'`).run();
db.prepare(`INSERT INTO project_artifacts (id, projectId, kind, displayName, relativePath, mimeType, createdAt) VALUES
  ('artifact-a', 'project-a', 'video', '引用', ?, 'video/mp4', ?)
`).run(firstRow.relativePath, '2026-07-24T00:00:00.000Z');
assert.throws(
  () => workspace.deleteShotSetExternalAsset({ projectId: 'project-a', shotSetId: 'set-a', assetId: first.assets[0].id }),
  (error: unknown) => error instanceof FinalEditError && error.code === 'external_asset_in_use',
);
db.prepare(`DELETE FROM project_artifacts WHERE id='artifact-a'`).run();

const deleted = workspace.deleteShotSetExternalAsset({ projectId: 'project-a', shotSetId: 'set-a', assetId: first.assets[0].id });
assert.equal(deleted.deleted, true);
assert.equal(fs.existsSync(path.join(storageRoot, firstRow.relativePath)), false);
assert.equal(fs.existsSync(path.join(storageRoot, firstRow.thumbnailRelativePath)), false);
assert.equal(workspace.listShotSetExternalAssets('project-a', 'set-a').length, 0);

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('final-edit material import tests passed');
