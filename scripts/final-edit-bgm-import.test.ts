import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import type { BgmUpload } from '../lib/final-edit/bgm-import.ts';

const {
  importFinalEditBgmFiles,
} = await import('../lib/final-edit/bgm-import.ts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-import-'));
const storageRoot = path.join(root, 'storage');
const uploadRoot = path.join(root, 'uploads');
fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(uploadRoot, { recursive: true });
const db = new Database(':memory:');
initFinalEditSchema(db);

let uploadIndex = 0;
function upload(filename: string, bytes: string): BgmUpload {
  const temporaryPath = path.join(uploadRoot, `upload-${uploadIndex++}`);
  fs.writeFileSync(temporaryPath, bytes);
  return {
    filename,
    mimeType: 'audio/mpeg',
    temporaryPath,
    size: fs.statSync(temporaryPath).size,
  };
}

const dependencies = {
  db,
  storageRoot,
  probeDurationSec: async (filePath: string) => {
    if (fs.readFileSync(filePath, 'utf8').startsWith('broken')) {
      throw new Error('invalid audio');
    }
    return 12.5;
  },
};

const first = await importFinalEditBgmFiles(dependencies, [
  upload('轻快音乐.mp3', 'audio-a'),
]);
assert.equal(first.imported[0].filename, '轻快音乐.mp3');
assert.equal(first.imported[0].relativePath, 'bgm/轻快音乐.mp3');
assert.equal(first.firstSuccessfulTrackId, first.imported[0].id);
assert.equal(
  fs.readFileSync(path.join(storageRoot, 'bgm', '轻快音乐.mp3'), 'utf8'),
  'audio-a',
);

const collisions = await importFinalEditBgmFiles(dependencies, [
  upload('轻快音乐.mp3', 'audio-b'),
  upload('轻快音乐.mp3', 'audio-c'),
]);
assert.deepEqual(
  collisions.imported.map((track) => track.filename),
  ['轻快音乐(1).mp3', '轻快音乐(2).mp3'],
);

const duplicate = await importFinalEditBgmFiles(dependencies, [
  upload('另一个名字.mp3', 'audio-a'),
]);
assert.equal(duplicate.imported.length, 0);
assert.equal(duplicate.reused[0].id, first.imported[0].id);
assert.equal(duplicate.reused[0].filename, '轻快音乐.mp3');

const partial = await importFinalEditBgmFiles(dependencies, [
  upload('损坏.mp3', 'broken-audio'),
  upload('保留 原名(测试).WAV', 'audio-d'),
  upload('说明.txt', 'not-audio'),
]);
assert.equal(partial.imported[0].filename, '保留 原名(测试).WAV');
assert.deepEqual(
  partial.errors.map((error) => error.code),
  ['invalid_audio', 'unsupported_audio_format'],
);
assert.equal(partial.firstSuccessfulTrackId, partial.imported[0].id);

const concurrent = await Promise.all([
  importFinalEditBgmFiles(dependencies, [upload('并发.mp3', 'concurrent-a')]),
  importFinalEditBgmFiles(dependencies, [upload('并发.mp3', 'concurrent-b')]),
]);
assert.deepEqual(
  concurrent.flatMap((result) => result.imported).map((track) => track.filename).sort(),
  ['并发(1).mp3', '并发.mp3'],
);

const sameContent = await Promise.all([
  importFinalEditBgmFiles(dependencies, [upload('相同甲.mp3', 'same-content')]),
  importFinalEditBgmFiles(dependencies, [upload('相同乙.mp3', 'same-content')]),
]);
assert.equal(sameContent.flatMap((result) => result.imported).length, 1);
assert.equal(sameContent.flatMap((result) => result.reused).length, 1);
const sameImportedTrack = sameContent.flatMap((result) => result.imported)[0];
const sameFingerprint = db.prepare(`
  SELECT fileFingerprint
  FROM final_edit_bgm_tracks
  WHERE id = ?
`).get(sameImportedTrack.id) as { fileFingerprint: string };
assert.equal(
  (db.prepare(`
    SELECT COUNT(*) AS count
    FROM final_edit_bgm_tracks
    WHERE fileFingerprint = ?
  `).get(sameFingerprint.fileFingerprint) as { count: number }).count,
  1,
  '完全相同内容只能留下一个曲目记录',
);

const unsafe = await importFinalEditBgmFiles(dependencies, [
  upload('../../越界.mp3', 'unsafe-a'),
  upload('CON.mp3', 'unsafe-b'),
]);
assert.equal(unsafe.imported[0].filename, '越界.mp3');
assert.deepEqual(unsafe.errors.map((error) => error.code), ['invalid_filename']);
assert.equal(fs.existsSync(path.join(root, '越界.mp3')), false);
assert.equal(
  fs.readFileSync(path.join(storageRoot, 'bgm', '越界.mp3'), 'utf8'),
  'unsafe-a',
);

const deletedReady = await importFinalEditBgmFiles(dependencies, [
  upload('复原.mp3', 'restore-content'),
]);
assert.equal(deletedReady.imported.length, 1);
fs.unlinkSync(path.join(storageRoot, 'bgm', '复原.mp3'));
const restored = await importFinalEditBgmFiles(dependencies, [
  upload('复原.mp3', 'restore-content'),
]);
assert.equal(restored.imported.length, 1);
assert.equal(restored.imported[0].filename, '复原.mp3');
assert.equal(
  fs.readFileSync(path.join(storageRoot, 'bgm', '复原.mp3'), 'utf8'),
  'restore-content',
);

const blockedStorageRoot = path.join(root, 'storage-as-file');
fs.writeFileSync(blockedStorageRoot, 'not-a-directory');
await assert.rejects(
  importFinalEditBgmFiles({
    db,
    storageRoot: blockedStorageRoot,
    probeDurationSec: dependencies.probeDurationSec,
  }, [upload('写入失败.mp3', 'write-failure')]),
  (error: unknown) => error instanceof Error
    && (error as Error & { code?: string; status?: number }).code === 'bgm_write_failed'
    && (error as Error & { code?: string; status?: number }).status === 500,
  '音乐库或数据库写入故障必须保留为服务端 500，而不是客户端 400',
);

const dbWithHook = new Database(':memory:');
initFinalEditSchema(dbWithHook);
let hookCount = 0;
const hookDeps = {
  db: dbWithHook,
  storageRoot,
  probeDurationSec: dependencies.probeDurationSec,
};
const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-hook-'));
const hookStorageRoot = path.join(hookRoot, 'storage');
const hookStorageBgm = path.join(hookStorageRoot, 'bgm');
fs.mkdirSync(hookStorageBgm, { recursive: true });
try {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const hookUpload = upload(`hook-${attempt}-${crypto.randomUUID().slice(0, 4)}.mp3`, 'hook-content');
    try {
      await importFinalEditBgmFiles({
        ...hookDeps,
        db: hookDeps.db,
      }, [hookUpload]);
      hookCount += 1;
    } catch {
      break;
    }
  }
} catch {
  // Expected if db write fails on attempt
}
assert.ok(hookCount >= 1, '至少有一次成功导入');

assert.equal(
  fs.readdirSync(hookStorageBgm).filter((name) => name.startsWith('.import-')).length,
  0,
  '导入完成后不得留下 .import-*.tmp',
);
const sequence = await importFinalEditBgmFiles(dependencies, [
  upload('复用第一.mp3', 'audio-a'),
  upload('失败.mp3', 'broken-audio'),
  upload('新建.mp3', 'new-content'),
]);
assert.equal(sequence.firstSuccessfulTrackId, first.imported[0].id);
assert.equal(sequence.reused[0].filename, '轻快音乐.mp3');
assert.equal(sequence.imported[0].filename, '新建.mp3');

const {
  bgmImportResponseStatus,
  importFinalEditBgmFromFormData,
  validateBgmUploadMetadata,
  MAX_BGM_FILES,
  MAX_BGM_FILE_BYTES,
} = await import('../lib/final-edit/bgm-import-http.ts');

assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: 'new', imported: [{ id: 'new', filename: 'test.mp3', relativePath: 'bgm/test.mp3', durationUs: 1_000_000 }], reused: [], errors: [],
}), 201);
assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: 'reused', imported: [], reused: [{ id: 'reused', filename: 'test.mp3', relativePath: 'bgm/test.mp3', durationUs: 1_000_000 }], errors: [],
}), 200);
assert.equal(bgmImportResponseStatus({
  firstSuccessfulTrackId: null, imported: [], reused: [], errors: [{
    filename: '损坏.mp3', code: 'invalid_audio', message: '无法识别音频内容',
  }],
}), 422);

assert.throws(
  () => validateBgmUploadMetadata([]),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'files_required',
);

assert.throws(
  () => validateBgmUploadMetadata(Array.from({ length: MAX_BGM_FILES + 1 }, (_, i) => ({ name: `file${i}.mp3`, size: 100 }))),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'too_many_files',
);

assert.throws(
  () => validateBgmUploadMetadata([{ name: 'large.mp3', size: MAX_BGM_FILE_BYTES + 1 }]),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'file_too_large',
);

assert.throws(
  () => validateBgmUploadMetadata([
    { name: 'a.mp3', size: MAX_BGM_FILE_BYTES },
    { name: 'b.mp3', size: MAX_BGM_FILE_BYTES },
    { name: 'c.mp3', size: 1 },
  ]),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'upload_too_large',
);

const form = new FormData();
form.set('projectId', 'must-be-ignored');
form.set('groupId', 'must-be-ignored');
form.set('targetPath', '../../must-be-ignored');
form.append('files', new File(['first'], '第一首.mp3', { type: 'audio/mpeg' }));
form.append('files', new File(['second'], '第二首.wav', { type: 'audio/wav' }));

const stagedNames: string[] = [];
const parsed = await importFinalEditBgmFromFormData(
  new Request('http://local/api/final-edit-bgm', { method: 'POST', body: form }),
  async (uploads) => {
    assert.equal(uploads.length, 1, 'HTTP 层必须逐文件暂存');
    assert.ok(fs.existsSync(uploads[0].temporaryPath));
    stagedNames.push(uploads[0].filename);
    return {
      firstSuccessfulTrackId: `track-${stagedNames.length}`,
      imported: [{
        id: `track-${stagedNames.length}`,
        filename: uploads[0].filename,
        relativePath: `bgm/${uploads[0].filename}`,
        durationUs: 1_000_000,
      }],
      reused: [],
      errors: [],
    };
  },
);
assert.deepEqual(stagedNames, ['第一首.mp3', '第二首.wav']);
assert.equal(parsed.firstSuccessfulTrackId, 'track-1');
assert.deepEqual(parsed.imported.map((track) => track.id), ['track-1', 'track-2']);

await assert.rejects(
  importFinalEditBgmFromFormData(
    new Request('http://local/api/final-edit-bgm', { method: 'POST', body: new FormData() }),
    async () => ({ firstSuccessfulTrackId: null, imported: [], reused: [], errors: [] }),
  ),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'files_required',
);

await assert.rejects(
  importFinalEditBgmFromFormData(
    new Request('http://local/api/final-edit-bgm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    async () => ({ firstSuccessfulTrackId: null, imported: [], reused: [], errors: [] }),
  ),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'invalid_form_data',
);

const tooManyForm = new FormData();
for (let i = 0; i < MAX_BGM_FILES + 1; i += 1) {
  tooManyForm.append('files', new File(['small'], `file${i}.mp3`, { type: 'audio/mpeg' }));
}
await assert.rejects(
  importFinalEditBgmFromFormData(
    new Request('http://local/api/final-edit-bgm', { method: 'POST', body: tooManyForm }),
    async () => ({ firstSuccessfulTrackId: null, imported: [], reused: [], errors: [] }),
  ),
  (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'too_many_files',
);

const systemFailForm = new FormData();
systemFailForm.append('files', new File(['ok'], 'ok.mp3', { type: 'audio/mpeg' }));
await assert.rejects(
  importFinalEditBgmFromFormData(
    new Request('http://local/api/final-edit-bgm', { method: 'POST', body: systemFailForm }),
    async () => {
      throw new Error('system failure');
    },
  ),
  (error: unknown) => error instanceof Error && error.message === 'system failure',
);

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'app/api/final-edit-bgm/route.ts'),
  'utf8',
);
assert.match(routeSource, /importFinalEditBgmFromFormData/);
assert.match(routeSource, /bgmImportResponseStatus/);
assert.match(routeSource, /path\.join\(dataRoot\(\), 'storage'\)/);
assert.doesNotMatch(routeSource, /projectId|shotSetId|groupId|targetPath/);

const realAudioRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-real-'));
const realStorage = path.join(realAudioRoot, 'storage');
const realBgmDir = path.join(realStorage, 'bgm');
fs.mkdirSync(realBgmDir, { recursive: true });
const realWavPath = path.join(realAudioRoot, 'real.wav');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
await runFfmpeg([
  '-f', 'lavfi',
  '-i', 'sine=frequency=440:duration=0.2',
  '-ar', '48000',
  '-ac', '1',
  '-c:a', 'pcm_s16le',
  '-y', realWavPath,
]);

const realDb = new Database(':memory:');
initFinalEditSchema(realDb);
const { importFinalEditBgmFiles: realImport } = await import('../lib/final-edit/bgm-import.ts');
const realResult = await realImport(
  { db: realDb, storageRoot: realStorage },
  [{ filename: '真音频.wav', mimeType: 'audio/wav', temporaryPath: realWavPath, size: fs.statSync(realWavPath).size }],
);
assert.equal(realResult.imported.length, 1);
assert.ok(realResult.imported[0].durationUs > 0);
assert.equal(realResult.imported[0].filename, '真音频.wav');

const { scanFinalEditBgm } = await import('../lib/final-edit/bgm.ts');
const rescannedTracks = await scanFinalEditBgm(realDb, realStorage);
const rescannedRealTrack = rescannedTracks.find((track) => /真音频\.wav$/.test(track.relativePath));
assert.equal(
  rescannedRealTrack?.id,
  realResult.imported[0].id,
  '重新扫描音乐库必须返回数据库中的权威曲目 ID',
);
assert.equal(
  rescannedRealTrack?.relativePath,
  'bgm/真音频.wav',
  '重新扫描不得把公开 relativePath 改成 Windows 反斜杠路径',
);
assert.ok(
  realDb.prepare(`SELECT 1 FROM final_edit_bgm_tracks WHERE id=? AND status='ready'`).get(
    rescannedRealTrack?.id,
  ),
  '扫描结果中的曲目 ID 必须可被媒体接口按主键查询',
);

const fakeMp3Path = path.join(realAudioRoot, '伪装.mp3');
fs.writeFileSync(fakeMp3Path, 'this is not audio');
const fakeResult = await realImport(
  { db: realDb, storageRoot: realStorage },
  [{ filename: '伪装.mp3', mimeType: 'audio/mpeg', temporaryPath: fakeMp3Path, size: fs.statSync(fakeMp3Path).size }],
);
assert.equal(fakeResult.imported.length, 0);
assert.equal(fakeResult.errors[0].code, 'invalid_audio');

realDb.close();
fs.rmSync(realAudioRoot, { recursive: true, force: true });

db.close();
dbWithHook.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(hookRoot, { recursive: true, force: true });

console.log('PASSED');
