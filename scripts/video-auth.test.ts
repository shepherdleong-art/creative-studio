import assert from 'node:assert/strict';
import { resolveKlingCredentialPair } from '../lib/video-auth.ts';

assert.deepEqual(
  resolveKlingCredentialPair({
    KLING_VIDEO_ACCESS_KEY: 'access-from-env',
    KLING_VIDEO_SECRET_KEY: 'secret-from-env',
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }, 'KLING_VIDEO_API_KEY', {
    accessKey: 'access-from-db',
    secretKey: 'secret-from-db',
  }),
  { accessKey: 'access-from-db', secretKey: 'secret-from-db', source: 'split-env' }
);

assert.deepEqual(
  resolveKlingCredentialPair({
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }, 'KLING_VIDEO_API_KEY', {
    apiKey: 'db-access:db-secret',
  }),
  { accessKey: 'db-access', secretKey: 'db-secret', source: 'legacy-combined' }
);

assert.equal(
  resolveKlingCredentialPair({
    KLING_VIDEO_ACCESS_KEY: 'access-from-env',
    KLING_VIDEO_SECRET_KEY: 'secret-from-env',
  }),
  null
);

assert.throws(
  () => resolveKlingCredentialPair({
    KLING_VIDEO_ACCESS_KEY: 'access-only',
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }, 'KLING_VIDEO_API_KEY', { accessKey: 'access-only' }),
  /Set both KLING_VIDEO_ACCESS_KEY and KLING_VIDEO_SECRET_KEY/
);
