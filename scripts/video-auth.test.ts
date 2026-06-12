import assert from 'node:assert/strict';
import { resolveKlingCredentialPair } from '../lib/video-auth';

assert.deepEqual(
  resolveKlingCredentialPair({
    KLING_VIDEO_ACCESS_KEY: 'access-from-env',
    KLING_VIDEO_SECRET_KEY: 'secret-from-env',
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }),
  { accessKey: 'access-from-env', secretKey: 'secret-from-env', source: 'split-env' }
);

assert.deepEqual(
  resolveKlingCredentialPair({
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }),
  { accessKey: 'legacy-access', secretKey: 'legacy-secret', source: 'legacy-combined' }
);

assert.throws(
  () => resolveKlingCredentialPair({
    KLING_VIDEO_ACCESS_KEY: 'access-only',
    KLING_VIDEO_API_KEY: 'legacy-access:legacy-secret',
  }),
  /Set both KLING_VIDEO_ACCESS_KEY and KLING_VIDEO_SECRET_KEY/
);
