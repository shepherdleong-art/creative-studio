import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-image-url-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = tmpDir;

const originalNetworkInterfaces = os.networkInterfaces;
os.networkInterfaces = () => ({
  Ethernet: [{
    address: '10.123.45.67',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: '10.123.45.67/24',
  }],
});

const storageDir = path.join(tmpDir, 'storage', 'processed');
fs.mkdirSync(storageDir, { recursive: true });
const imagePath = path.join(storageDir, '场景 图.png');
fs.writeFileSync(imagePath, Buffer.from([1]));

try {
  // dataRoot() depends on the environment, so import after setting the data root.
  const {
    isPrivateOrLocalHttpUrl,
    resolvePublicImageUrl,
    resolvePublicImageUrlWithSource,
  } = await import('../lib/local-image-url.ts');

  process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL = 'https://media.example.com/';
  const expectedConfiguredUrl =
    `https://media.example.com/api/images/processed/${encodeURIComponent('场景 图.png')}`;

  assert.deepEqual(resolvePublicImageUrlWithSource(imagePath), {
    url: expectedConfiguredUrl,
    source: 'configured',
  });
  assert.equal(resolvePublicImageUrl(imagePath), expectedConfiguredUrl);

  delete process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL;
  delete process.env.PORT;
  const auto = resolvePublicImageUrlWithSource(imagePath);
  const expectedNetworkUrl =
    `http://10.123.45.67:3000/api/images/processed/${encodeURIComponent('场景 图.png')}`;
  assert.deepEqual(auto, {
    url: expectedNetworkUrl,
    source: 'network',
  });
  assert.equal(resolvePublicImageUrl(imagePath), expectedNetworkUrl);

  process.env.PORT = '3456';
  const withPort = resolvePublicImageUrlWithSource(imagePath);
  assert.deepEqual(withPort, {
    url: `http://10.123.45.67:3456/api/images/processed/${encodeURIComponent('场景 图.png')}`,
    source: 'network',
  });
  delete process.env.PORT;

  const outsidePath = path.join(tmpDir, 'outside.png');
  fs.writeFileSync(outsidePath, Buffer.from([1]));
  assert.equal(resolvePublicImageUrlWithSource(outsidePath), null);
  assert.equal(resolvePublicImageUrl(outsidePath), null);

  for (const url of [
    'http://10.0.0.1/image.png',
    'https://172.16.0.1/image.png',
    'http://172.31.255.254/image.png',
    'https://192.168.1.10/image.png',
    'http://127.0.0.1/image.png',
    'https://169.254.10.20/image.png',
  ]) {
    assert.equal(isPrivateOrLocalHttpUrl(url), true, `${url} should be private/local`);
  }
  assert.equal(isPrivateOrLocalHttpUrl('http://172.15.255.255/image.png'), false);
  assert.equal(isPrivateOrLocalHttpUrl('http://172.32.0.0/image.png'), false);
  assert.equal(isPrivateOrLocalHttpUrl('https://8.8.8.8/image.png'), false);
} finally {
  os.networkInterfaces = originalNetworkInterfaces;
  delete process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL;
  delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  delete process.env.PORT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('local-image-url tests passed');
