import assert from 'node:assert/strict';
import path from 'node:path';
import { canonicalJson, sha256Canonical } from '../lib/canonical-json.ts';
import {
  imageJobForClient,
  projectImageForClient,
  videoJobForClient,
} from '../lib/client-media-dto.ts';

const image = projectImageForClient({
  id: 'image-1',
  projectId: 'project-1',
  role: 'output',
  filename: 'result.png',
  path: path.join('I:', 'secret-root', 'storage', 'outputs', 'result.png'),
  originalPath: 'I:\\secret-root\\original.png',
  processedPath: 'I:\\secret-root\\processed.png',
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
  createdAt: '2026-11-11T00:00:00.000Z',
});
assert.equal(image.id, 'image-1');
assert.equal(typeof image.imageUrl, 'string');
assert.equal(typeof image.relativePath, 'string');
for (const key of ['path', 'originalPath', 'processedPath']) assert.equal(key in image, false);

const imageJob = imageJobForClient({
  id: 'job-1',
  projectId: 'project-1',
  status: 'canceled',
  providerRawResponse: '{"authorization":"Bearer secret"}',
  remoteImageUrl: 'https://cdn.example.test/result.png?signature=secret',
  inputFilename: 'input.png',
  outputFilename: 'result.png',
  unifiedModel: 'image2',
});
assert.equal(imageJob.status, 'canceled');
assert.equal(imageJob.inputFilename, 'input.png');
assert.equal(imageJob.unifiedModel, 'image2');
for (const key of ['providerRawResponse', 'remoteImageUrl']) assert.equal(key in imageJob, false);

const videoJob = videoJobForClient({
  id: 'video-1',
  projectId: 'project-1',
  status: 'canceled',
  providerStatus: 'succeeded',
  filename: 'clip.mp4',
  localVideoPath: 'I:\\secret-root\\storage\\videos\\clip.mp4',
  remoteVideoUrl: 'https://cdn.example.test/clip.mp4?signature=secret',
  providerRawResponse: '{"secret":true}',
  posterImagePath: 'I:\\secret-root\\storage\\outputs\\poster.jpg',
  cancelRequestedAt: '2026-11-11T00:00:00.000Z',
});
assert.equal(videoJob.id, 'video-1');
assert.equal(videoJob.hasLocalVideo, true);
assert.equal(typeof videoJob.videoUrl, 'string');
assert.equal(typeof videoJob.posterImageUrl, 'string');
for (const key of ['localVideoPath', 'remoteVideoUrl', 'providerRawResponse', 'posterImagePath']) {
  assert.equal(key in videoJob, false);
}

assert.equal(canonicalJson({ b: 2, a: [1, { d: undefined, c: 3 }] }), '{"a":[1,{"c":3}],"b":2}');
assert.equal(
  sha256Canonical({ b: 2, a: [1, { c: 3 }] }),
  sha256Canonical({ a: [1, { c: 3 }], b: 2 }),
  'shared canonical hash must be key-order independent',
);

console.log('client media DTO tests passed');
