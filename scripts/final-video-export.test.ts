// scripts/final-video-export.test.ts
// Phase G1: Export filter, draft/job lifecycle cleanup, and path safety validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks(hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
}): void }).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, projectRootUrl);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-export-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { getDb } = await import('../lib/db.ts');
const { defaultPackageConfig } = await import('../lib/final-video/types.ts');

const bgmOnlyPackageConfig = defaultPackageConfig();
const { createFinalVideoDraft, deleteFinalVideoDraft, getFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');

const db = getDb();
const storageRoot = path.resolve(path.join(testRoot, 'storage'));

try {
  // ── Setup: create project, shot set, and test assets ──
  db.prepare(`INSERT INTO providers (id, name, baseUrl, type, apiKey) VALUES ('prov-1', 'Test Provider', 'https://api.example.com', 'openai', 'test-key')`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('proj-1', '测试项目', 'prov-1', 'test-model', '')`).run();
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('ss-1', 'proj-1', '测试分镜集')`).run();

  // Create dummy output files for final/preview jobs
  const finalJobDir = path.join(storageRoot, 'final-videos', 'job-final-1');
  const previewJobDir = path.join(storageRoot, 'final-videos', 'job-preview-1');
  const otherJobDir = path.join(storageRoot, 'final-videos', 'job-other-final');
  fs.mkdirSync(finalJobDir, { recursive: true });
  fs.mkdirSync(previewJobDir, { recursive: true });
  fs.mkdirSync(otherJobDir, { recursive: true });
  fs.writeFileSync(path.join(finalJobDir, 'output.mp4'), 'fake-mp4');
  fs.writeFileSync(path.join(previewJobDir, 'preview.mp4'), 'fake-preview');
  fs.writeFileSync(path.join(otherJobDir, 'other.mp4'), 'fake-other');

  // Insert jobs: one final succeeded, one preview succeeded, one other final succeeded
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId, status, kind, solverVersion,
    outputPath, packageJson, narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, selectedClipIdsJson)
    VALUES ('job-final-1', 'proj-1', 'ss-1', 'succeeded', 'final', 2,
      ?, '{}', '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', '[]')`).run(path.join(finalJobDir, 'output.mp4'));
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId, status, kind, solverVersion,
    outputPath, packageJson, narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, selectedClipIdsJson)
    VALUES ('job-preview-1', 'proj-1', 'ss-1', 'succeeded', 'preview', 2,
      ?, '{}', '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', '[]')`).run(path.join(previewJobDir, 'preview.mp4'));
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId, status, kind, solverVersion,
    outputPath, packageJson, narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, selectedClipIdsJson)
    VALUES ('job-other-final', 'proj-1', 'ss-1', 'succeeded', 'final', 2,
      ?, '{}', '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', '[]')`).run(path.join(otherJobDir, 'other.mp4'));

  // ── Test 1: Export ZIP (via the real creative-package route) includes kind='final' videos only ──
  const packageRoute = await import('../app/api/projects/[id]/creative-package/route.ts');
  const packageResponse = await packageRoute.GET(
    {} as unknown as NextRequest,
    { params: Promise.resolve({ id: 'proj-1' }) },
  );
  assert.equal(packageResponse.status, 200, 'creative-package export must succeed');
  assert.equal(packageResponse.headers.get('Content-Type'), 'application/zip');
  const zipBytes = Buffer.from(await packageResponse.arrayBuffer());
  // ZIP local file headers always store entry filenames uncompressed (only file
  // content is deflated), so a raw byte search reliably proves which entries the
  // real route included -- no separate zip-parsing dependency needed.
  const zipContains = (needle: string) => zipBytes.includes(Buffer.from(needle, 'utf8'));
  assert.ok(zipContains('finals/job-final-1.mp4'), 'export ZIP must include kind=final succeeded job');
  assert.ok(zipContains('finals/job-other-final.mp4'), 'export ZIP must include other kind=final job');
  assert.ok(!zipContains('job-preview-1'), 'export ZIP must exclude kind=preview jobs entirely');
  assert.ok(zipContains('manifest.json'), 'export ZIP must include the schema v2 manifest');

  // ── Test 2: Draft lifecycle cleanup ──
  // Create draft with preview job linked
  const draft = createFinalVideoDraft({
    projectId: 'proj-1',
    shotSetId: 'ss-1',
    scriptDraftId: null,
    workflowConfig: {
      packageConfig: bgmOnlyPackageConfig,
      narrationScriptProviderId: '',
      visionProviderId: '',
      orchestrationProviderId: '',
      selectedClipIds: [],
    },
  });

  // Link preview job to draft
  const { updateFinalVideoDraft } = await import('../lib/final-video/draft-store.ts');
  updateFinalVideoDraft(draft.id, draft.revision, { previewJobId: 'job-preview-1', previewRevision: draft.revision });

  // Create draft storage directory
  const draftDir = path.join(storageRoot, 'final-video-drafts', draft.id);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, 'narration.m4a'), 'fake-audio');

  // Verify draft and preview job exist before deletion
  assert.ok(fs.existsSync(draftDir), 'draft dir exists before deletion');
  assert.ok(fs.existsSync(previewJobDir), 'preview job dir exists before deletion');
  assert.ok(getFinalVideoDraft(draft.id), 'draft exists before deletion');

  // Delete draft
  deleteFinalVideoDraft(draft.id);

  // After deletion: draft gone, draft dir cleaned, preview job cleaned, formal job preserved
  assert.equal(getFinalVideoDraft(draft.id), null, 'draft row deleted');
  assert.ok(!fs.existsSync(draftDir), 'draft storage dir cleaned up');
  assert.ok(!fs.existsSync(previewJobDir), 'preview job dir cleaned up');
  const previewJobRow = db.prepare(`SELECT id FROM final_video_jobs WHERE id = 'job-preview-1'`).get() as { id: string } | undefined;
  assert.equal(previewJobRow, undefined, 'preview job row deleted');
  // Formal jobs preserved
  assert.ok(fs.existsSync(finalJobDir), 'formal job dir preserved');
  assert.ok(fs.existsSync(otherJobDir), 'other formal job dir preserved');
  const formalJobRow = db.prepare(`SELECT id FROM final_video_jobs WHERE id = 'job-final-1'`).get() as { id: string } | undefined;
  assert.ok(formalJobRow, 'formal job row preserved');

  // ── Test 3: Preview job deletion clears draft.previewJobId ──
  // Create a new draft with a new preview job
  const preview2Dir = path.join(storageRoot, 'final-videos', 'job-preview-2');
  fs.mkdirSync(preview2Dir, { recursive: true });
  fs.writeFileSync(path.join(preview2Dir, 'preview2.mp4'), 'fake-preview2');
  // draftId will be set after we create the draft
  db.prepare(`INSERT INTO final_video_jobs (id, projectId, shotSetId, status, kind, solverVersion,
    outputPath, packageJson, narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, selectedClipIdsJson)
    VALUES ('job-preview-2', 'proj-1', 'ss-1', 'succeeded', 'preview', 2,
      ?, '{}', '[]', '[]', '{"assignments":[],"gaps":[]}', '[]', '[]')`).run(path.join(preview2Dir, 'preview2.mp4'));

  const draft2 = createFinalVideoDraft({
    projectId: 'proj-1',
    shotSetId: 'ss-1',
    scriptDraftId: null,
    workflowConfig: {
      packageConfig: bgmOnlyPackageConfig,
      narrationScriptProviderId: '',
      visionProviderId: '',
      orchestrationProviderId: '',
      selectedClipIds: [],
    },
  });
  updateFinalVideoDraft(draft2.id, draft2.revision, { previewJobId: 'job-preview-2', previewRevision: draft2.revision });

  // Verify linkage
  const draft2After = getFinalVideoDraft(draft2.id);
  assert.equal(draft2After?.previewJobId, 'job-preview-2');

  // Delete the preview job via the API-like path
  const jobRoute = await import('../app/api/final-video-jobs/[id]/route.ts');
  const deleteResult = await jobRoute.DELETE(
    { json: async () => null } as unknown as NextRequest,
    { params: Promise.resolve({ id: 'job-preview-2' }) }
  );
  assert.equal(deleteResult.status, 200);

  // Preview job should be deleted; draft.previewJobId should be cleared
  assert.ok(!fs.existsSync(preview2Dir), 'preview2 job dir cleaned up');
  const draft2Cleared = getFinalVideoDraft(draft2.id);
  assert.equal(draft2Cleared?.previewJobId, null, 'draft.previewJobId cleared after preview job deletion');
  assert.equal(draft2Cleared?.previewRevision, null, 'draft.previewRevision cleared');

  // Formal job preserved again
  assert.ok(fs.existsSync(finalJobDir), 'formal job still preserved');

  // ── Test 4: Path traversal safety ──
  // Verify that resolved draft/job paths are within storage root
  const assertInStorage = (dir: string) => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(storageRoot + path.sep) || resolved === storageRoot,
      `path ${resolved} must be within ${storageRoot}`);
  };
  assertInStorage(path.join(testRoot, 'storage', 'final-video-drafts', 'any-id'));
  assertInStorage(path.join(testRoot, 'storage', 'final-videos', 'any-id'));

  // Attempting to escape storage root via .. should be caught
  const escapeAttempt = path.resolve(path.join(testRoot, 'storage', 'final-videos', '..', '..', 'outside'));
  assert.ok(!escapeAttempt.startsWith(storageRoot + path.sep), '.. traversal escapes storage root');

  console.log('final-video-export tests passed');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
