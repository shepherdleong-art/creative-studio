import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  getVideoTailFrameCapability,
  validateVideoTailFrameBatchDrafts,
  validateVideoTailFrameAsset,
  validateVideoTailFrameUpload,
  VIDEO_TAIL_FRAME_USAGE,
} = await import('../lib/video-tail-frame.ts');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    role TEXT NOT NULL,
    usage TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    processedPath TEXT,
    mimeType TEXT NOT NULL
  );
  INSERT INTO projects (id) VALUES ('project-a');
  INSERT INTO image_assets
    (id, projectId, role, usage, path, processedPath, mimeType)
  VALUES
    ('tail-ok', 'project-a', 'input', 'video_tail_frame', '/tmp/tail-ok.png', NULL, 'image/png'),
    ('tail-other-project', 'project-b', 'input', 'video_tail_frame', '/tmp/tail-other.png', NULL, 'image/png'),
    ('not-tail', 'project-a', 'input', 'shot_source', '/tmp/not-tail.png', NULL, 'image/png'),
    ('reference-tail', 'project-a', 'reference', 'video_tail_frame', '/tmp/reference-tail.png', NULL, 'image/png');
`);

assert.equal(validateVideoTailFrameUpload({
  db,
  usage: 'shot_source',
  role: 'input',
  projectId: null,
  fileCount: 2,
}), null);
assert.equal(validateVideoTailFrameUpload({
  db,
  usage: VIDEO_TAIL_FRAME_USAGE,
  role: 'input',
  projectId: 'project-a',
  fileCount: 1,
}), null);
assert.equal(validateVideoTailFrameUpload({
  db,
  usage: VIDEO_TAIL_FRAME_USAGE,
  role: 'input',
  projectId: 'project-a',
  fileCount: 2,
}), '尾帧图一次只能上传 1 张');
assert.equal(validateVideoTailFrameUpload({
  db,
  usage: VIDEO_TAIL_FRAME_USAGE,
  role: 'reference',
  projectId: 'project-a',
  fileCount: 1,
}), '尾帧图必须作为输入图片上传');
assert.equal(validateVideoTailFrameUpload({
  db,
  usage: VIDEO_TAIL_FRAME_USAGE,
  role: 'input',
  projectId: null,
  fileCount: 1,
}), '尾帧图必须属于当前项目');
assert.equal(validateVideoTailFrameUpload({
  db,
  usage: VIDEO_TAIL_FRAME_USAGE,
  role: 'input',
  projectId: 'missing-project',
  fileCount: 1,
}), '当前项目不存在');

assert.equal(VIDEO_TAIL_FRAME_USAGE, 'video_tail_frame');

assert.equal(validateVideoTailFrameBatchDrafts([
  { prompt: '', tailImageId: 'tail-ok' },
  { prompt: '正常行', tailImageId: null },
]), '已添加尾帧的运镜必须填写提示词');
assert.equal(validateVideoTailFrameBatchDrafts([
  { prompt: '', tailImageId: null },
  { prompt: '正常行', tailImageId: 'tail-ok' },
]), null);

assert.deepEqual(
  getVideoTailFrameCapability('jimeng', 'doubao-seedance-2-0-260128'),
  { supported: true, protocol: 'ark-content-roles' },
);
assert.deepEqual(
  getVideoTailFrameCapability('jimeng', 'doubao-seedance-1-5-pro-251215'),
  { supported: false, reason: 'unsupported_model' },
);
assert.deepEqual(
  getVideoTailFrameCapability('openai-video', 'doubao-seedance-2-0-260128'),
  { supported: true, protocol: 'company-gateway-seedance' },
);
assert.deepEqual(
  getVideoTailFrameCapability('openai-video', 'doubao-seedance-2-0-fast-260128'),
  { supported: true, protocol: 'company-gateway-seedance' },
);
assert.deepEqual(
  getVideoTailFrameCapability('openai-video', 'kling-3.0'),
  { supported: true, protocol: 'company-gateway-kling' },
);
assert.deepEqual(
  getVideoTailFrameCapability('openai-video', 'kling-2.5'),
  { supported: false, reason: 'contract_unverified' },
);

const noTail = validateVideoTailFrameAsset({
  db,
  tailImageId: null,
  projectId: 'project-a',
  providerType: 'jimeng',
  model: 'doubao-seedance-2-0-260128',
});
assert.deepEqual(noTail, { ok: true, asset: null });

const valid = validateVideoTailFrameAsset({
  db,
  tailImageId: 'tail-ok',
  projectId: 'project-a',
  providerType: 'jimeng',
  model: 'doubao-seedance-2-0-260128',
});
assert.equal(valid.ok, true);
assert.equal(valid.ok ? valid.asset?.id : null, 'tail-ok');

const unsupported = validateVideoTailFrameAsset({
  db,
  tailImageId: 'tail-ok',
  projectId: 'project-a',
  providerType: 'jimeng',
  model: 'doubao-seedance-1-5-pro-251215',
});
assert.equal(unsupported.ok, false);
assert.match(unsupported.ok ? '' : unsupported.error, /不支持首尾帧/);

const missing = validateVideoTailFrameAsset({
  db,
  tailImageId: 'missing',
  projectId: 'project-a',
  providerType: 'jimeng',
  model: 'doubao-seedance-2-0-260128',
});
assert.deepEqual(missing, { ok: false, error: '尾帧图不存在' });

const crossProject = validateVideoTailFrameAsset({
  db,
  tailImageId: 'tail-other-project',
  projectId: 'project-a',
  providerType: 'jimeng',
  model: 'doubao-seedance-2-0-260128',
});
assert.deepEqual(crossProject, { ok: false, error: '尾帧图不属于当前项目' });

for (const tailImageId of ['not-tail', 'reference-tail']) {
  const wrongUsage = validateVideoTailFrameAsset({
    db,
    tailImageId,
    projectId: 'project-a',
    providerType: 'jimeng',
    model: 'doubao-seedance-2-0-260128',
  });
  assert.deepEqual(wrongUsage, { ok: false, error: '该图片不是视频工位上传的尾帧图' });
}

console.log('video tail-frame validation tests passed');
