import assert from 'node:assert/strict';
import { withTeamCsrf } from '../lib/team-fetch-client.ts';

for (const existingToken of [false, true]) {
  const form = new FormData();
  form.append('files', new File([new Uint8Array([1, 2, 3, 255])], '共享音乐.mp3', { type: 'audio/mpeg' }));
  form.append('projectId', 'project-a');
  const original = new Request('https://studio.example.test/api/upload', {
    method: 'POST', body: form, headers: existingToken ? { 'x-csrf-token': 'existing' } : {},
  });
  const forwarded = withTeamCsrf(original, 'new-token');
  assert.equal(forwarded.headers.get('x-csrf-token'), existingToken ? 'existing' : 'new-token');
  // Serialize and parse the actual HTTP body; regenerating FormData with the old header fails here.
  const wire = new Request(forwarded.url, { method: forwarded.method, headers: forwarded.headers, body: await forwarded.arrayBuffer() });
  const received = await wire.formData();
  const file = received.get('files') as File;
  assert.equal(file.name, '共享音乐.mp3');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3, 255]));
  assert.equal(received.get('projectId'), 'project-a');
}
console.log('team-fetch-client tests passed');
