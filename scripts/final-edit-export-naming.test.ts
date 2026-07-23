import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FinalEditError } from '../lib/final-edit/workspace.ts';
import type { ExportIdentity, MixcutErrorCode } from '../lib/final-edit/types.ts';

// ---------------------------------------------------------------------------
// Phase 0 contract-freeze test for `lib/final-edit/export-naming.ts`.
//
// That module does NOT exist yet — implementing it is Phase 6's job (see
// docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md §12,
// Phase 6: "实现 export-naming.ts、碰撞序号与目录创建"). This file is expected
// to fail at the `await import(...)` below with a module-not-found error
// until Phase 6 lands — that failure is the correct, intentional state of
// the repo right now. Do not "fix" this by stubbing or implementing
// lib/final-edit/export-naming.ts; the point of this file is to pin down
// the exact contract (signatures, sanitization, collisions, path safety)
// that Phase 6 must satisfy. Rules encoded below are from plan §11.1-11.2
// and product spec §7.5.2.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL — error-signaling mechanism (the plan does not specify one
// for the `product_code_required` domain error).
//
// `lib/final-edit/workspace.ts` already has an established convention for
// domain errors in this exact module family: a thrown `FinalEditError`
// (code + http-ish status + optional details), asserted elsewhere via
// `error instanceof FinalEditError && error.code === '...'` — see
// scripts/final-edit-workspace.test.ts and scripts/final-edit-planner.test.ts.
// We follow that precedent here rather than inventing a result/union return
// type, so export-naming's domain error is asserted the same way.
// `FinalEditError` is imported from `workspace.ts` (its current home) only
// so this test can recognize the error by `instanceof`; exactly how
// `export-naming.ts` obtains/throws a `FinalEditError` (importing the class
// from `workspace.ts`, or Phase 6 relocating it to a lower-level module to
// avoid a workspace.ts <-> export-naming.ts import cycle once workspace.ts
// grows "export commands" per plan §3.2) is an implementation detail left
// to Phase 6 and is not asserted here.
// ---------------------------------------------------------------------------
const PRODUCT_CODE_REQUIRED: MixcutErrorCode = 'product_code_required';
function isProductCodeRequiredError(error: unknown): boolean {
  return error instanceof FinalEditError && error.code === PRODUCT_CODE_REQUIRED;
}

// ---------------------------------------------------------------------------
// JUDGMENT CALL — `ReservedPath` shape. Plan §11.2 only names the return
// type (`reserveExportPath(...): ReservedPath`) and never defines its
// fields. This is a minimal, assumed shape for THIS TEST FILE only, not a
// locked spec — Phase 6 may change it; update this interface and the
// assertions that read its fields to match whatever export-naming.ts
// actually exports at that point.
//
// Fields are inferred from §11.3's physical-layout example (a base name +
// extension resolves to one absolute file under
// `<storageRoot>/projects/<projectId>/成片/`) plus the `relativePath`
// convention already used elsewhere in this module family for
// storage-relative paths (e.g. `FinalEditGroupView.bgmTracks[].relativePath`
// and the `NarrationArtifact.relativePath` in workspace.ts, and
// `resolveStoragePath`/`toStorageRelativePath` in storage-path.ts).
// `filename` is broken out separately because Phase 6's ExportStep UI must
// display the filename on its own (plan §12 Phase 6: "ExportStep 显示任务名、
// 型号、日期、文件名和目标目录").
// ---------------------------------------------------------------------------
interface ReservedPath {
  /** Absolute filesystem path. Always resolved under `storageRoot` — see the path-traversal-safety assertions below. */
  absolutePath: string;
  /** `absolutePath` relative to `storageRoot`, mirroring `toStorageRelativePath()` in storage-path.ts. */
  relativePath: string;
  /** Final path segment only, e.g. `成片-JSQ-A1-20260723.mp4`. */
  filename: string;
}

// Minor undocumented-assumption: `extension` is passed WITH a leading dot
// (e.g. '.mp4'), matching `path.extname()`'s native format and the existing
// in-repo convention for extension strings — see
// `STORAGE_EXTENSIONS_IMAGE`/`assertStoragePath()`'s `allowedExts` in
// lib/zip-download.ts, which both store/compare extensions as '.png',
// '.mp4', etc. The plan itself never states this either way. If Phase 6
// picks the opposite convention, only this constant needs to change — the
// asserted filename strings below stay correct regardless, since they
// don't include this constant literally.
const MP4_EXTENSION = '.mp4';

type ExportNamingModule = {
  buildExportBaseName(identity: ExportIdentity): string;
  reserveExportPath(storageRoot: string, identity: ExportIdentity, extension: string): ReservedPath;
};

// The module under test does not exist yet. This dynamic import is expected
// to reject with ERR_MODULE_NOT_FOUND — see header comment above. Routing
// through `unknown` keeps this test file's own type-soundness independent
// of exactly what Phase 6 eventually exports.
const { buildExportBaseName, reserveExportPath } = (await import('../lib/final-edit/export-naming.ts')) as unknown as ExportNamingModule;

function makeIdentity(overrides: Partial<ExportIdentity> = {}): ExportIdentity {
  return {
    projectId: 'proj-basic',
    taskName: '样例任务',
    productCode: 'JSQ-A1',
    taskDate: '20260723',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. buildExportBaseName — basic case (plan §11.2 formula)
// ---------------------------------------------------------------------------
assert.equal(buildExportBaseName(makeIdentity()), '成片-JSQ-A1-20260723');

// ---------------------------------------------------------------------------
// 2. Sanitization — representative cases (plan §11.2: strip
//    `/ \ : * ? " < > |`, control characters, and trailing dots/spaces)
// ---------------------------------------------------------------------------

// 2a. all nine forbidden punctuation characters interleaved through the code
assert.equal(
  buildExportBaseName(makeIdentity({ productCode: 'J/S\\Q:A*1?B"C<D>E|F' })),
  '成片-JSQA1BCDEF-20260723',
);

// 2b. control characters (NUL and BEL, as representative examples —
// the rule says "control characters" generically) embedded in the code,
// written as \u escapes rather than raw bytes so the source file itself
// stays plain-text/diff-friendly.
assert.equal(
  buildExportBaseName(makeIdentity({ productCode: 'JSQ\u0000A\u00071' })),
  '成片-JSQA1-20260723',
);

// 2c. trailing dot(s)/space(s) — the plan's own example input (§11.2's rule
// text plus the task's illustrative productCode)
assert.equal(
  buildExportBaseName(makeIdentity({ productCode: 'JSQ-A1.  ' })),
  '成片-JSQ-A1-20260723',
);

// ---------------------------------------------------------------------------
// 3. Empty productCode -> `product_code_required` domain error
//    (plan §11.2: "productCode 为空时返回领域错误 product_code_required";
//    product spec §7.5.2: "如果 productCode 为空，导出前阻断并引导用户补充型号")
// ---------------------------------------------------------------------------
assert.throws(
  () => buildExportBaseName(makeIdentity({ productCode: '' })),
  isProductCodeRequiredError,
  '空 productCode 必须抛出 product_code_required',
);

// Whitespace-only is judged in-scope for "为空" (a documented judgment call,
// not a directly-quoted rule): productCode exists only to appear verbatim
// in a user-facing filename, so a value that is technically non-empty but
// carries no visible identifying content should be rejected the same way
// as ''.
assert.throws(
  () => buildExportBaseName(makeIdentity({ productCode: '   ' })),
  isProductCodeRequiredError,
  '仅空白的 productCode 应视为"为空"并抛出 product_code_required',
);

// reserveExportPath takes the full identity (not a pre-built base name), so
// it must derive the base name itself and should surface the same domain
// error rather than silently building a path with a blank product-code
// segment. (Inference beyond the letter of the rule text, called out here
// rather than asserted silently.)
{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-naming-empty-'));
  assert.throws(
    () => reserveExportPath(tempRoot, makeIdentity({ projectId: 'proj-empty', productCode: '' }), MP4_EXTENSION),
    isProductCodeRequiredError,
    'reserveExportPath 也必须对空 productCode 抛出 product_code_required',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Remaining assertions (#4-#6) exercise reserveExportPath's filesystem
// behavior against a real temp directory. One storageRoot is shared below;
// each sub-test uses its own projectId so their `成片/` directories can't
// collide with one another (plan §11.3:
// <storageRoot>/projects/<projectId>/成片/).
// ---------------------------------------------------------------------------
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-naming-'));

function assertUnderRoot(root: string, candidateAbsolutePath: string) {
  // Trailing separator guards the classic `/foo`.startsWith(`/foobar`) bug —
  // same technique as resolveStoragePath() in lib/final-edit/storage-path.ts.
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolvedCandidate = path.resolve(candidateAbsolutePath);
  assert.ok(
    resolvedCandidate.startsWith(resolvedRoot),
    `resolved export path escaped storageRoot: ${resolvedCandidate} not under ${resolvedRoot}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Path traversal safety (plan §14: no client-controlled absolute paths,
//    no directory traversal, no arbitrary local file access/writes)
// ---------------------------------------------------------------------------
{
  const traversalProjectId = 'proj-traversal';
  const exportDir = path.join(storageRoot, 'projects', traversalProjectId, '成片');
  fs.mkdirSync(exportDir, { recursive: true });

  // POSIX-style traversal. `/` is one of the stripped characters, so this
  // also guards against a regression in that stripping step specifically,
  // in addition to guarding the path-join/resolve logic itself.
  const posixTraversal = reserveExportPath(
    storageRoot,
    makeIdentity({ projectId: traversalProjectId, productCode: '../../../../etc/passwd' }),
    MP4_EXTENSION,
  );
  assertUnderRoot(storageRoot, posixTraversal.absolutePath);
  assert.ok(
    !posixTraversal.relativePath.split(/[\\/]/).includes('..'),
    'relativePath must not contain a ".." segment (POSIX traversal input)',
  );

  // Windows-style traversal. `\` is also one of the stripped characters.
  const windowsTraversal = reserveExportPath(
    storageRoot,
    makeIdentity({ projectId: traversalProjectId, productCode: '..\\..\\..\\windows\\system32\\config' }),
    MP4_EXTENSION,
  );
  assertUnderRoot(storageRoot, windowsTraversal.absolutePath);
  assert.ok(
    !windowsTraversal.relativePath.split(/[\\/]/).includes('..'),
    'relativePath must not contain a ".." segment (Windows-style traversal input)',
  );
}

// ---------------------------------------------------------------------------
// 5. Collision handling: base name taken -> -02, then -02 taken -> -03
//    (plan §11.2: "冲突时按 -02 起递增")
// ---------------------------------------------------------------------------
{
  const collisionProjectId = 'proj-collision';
  const exportDir = path.join(storageRoot, 'projects', collisionProjectId, '成片');
  fs.mkdirSync(exportDir, { recursive: true });
  const collisionIdentity = makeIdentity({ projectId: collisionProjectId });

  const basePath = path.join(exportDir, '成片-JSQ-A1-20260723.mp4');
  fs.writeFileSync(basePath, '');

  const second = reserveExportPath(storageRoot, collisionIdentity, MP4_EXTENSION);
  assert.equal(second.filename, '成片-JSQ-A1-20260723-02.mp4');
  assert.equal(path.resolve(second.absolutePath), path.resolve(exportDir, '成片-JSQ-A1-20260723-02.mp4'));

  fs.writeFileSync(second.absolutePath, '');

  const third = reserveExportPath(storageRoot, collisionIdentity, MP4_EXTENSION);
  assert.equal(third.filename, '成片-JSQ-A1-20260723-03.mp4');
  assert.equal(path.resolve(third.absolutePath), path.resolve(exportDir, '成片-JSQ-A1-20260723-03.mp4'));
}

// ---------------------------------------------------------------------------
// 6. No-collision case matches the plan's own example filename exactly
//    (product spec §7.5.2: "示例：成片-JSQ-A1-20260723.mp4")
// ---------------------------------------------------------------------------
{
  const cleanProjectId = 'proj-clean';
  const exportDir = path.join(storageRoot, 'projects', cleanProjectId, '成片');
  fs.mkdirSync(exportDir, { recursive: true });

  const reserved = reserveExportPath(storageRoot, makeIdentity({ projectId: cleanProjectId }), MP4_EXTENSION);
  assert.equal(reserved.filename, '成片-JSQ-A1-20260723.mp4');
  assert.equal(path.resolve(reserved.absolutePath), path.resolve(exportDir, '成片-JSQ-A1-20260723.mp4'));
}

fs.rmSync(storageRoot, { recursive: true, force: true });

console.log('final-edit export-naming contract tests passed');
