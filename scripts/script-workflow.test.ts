import assert from 'node:assert/strict';

const {
  canNavigateToScriptStep,
  getScriptStepStatus,
} = await import('../lib/script-workflow' + '.ts');

assert.deepEqual(
  getScriptStepStatus({ step: 1, hasAnalysis: false, hasScript: false }),
  {
    1: 'active',
    2: 'locked',
    3: 'locked',
  }
);

assert.deepEqual(
  getScriptStepStatus({ step: 3, hasAnalysis: true, hasScript: true }),
  {
    1: 'complete',
    2: 'complete',
    3: 'active',
  }
);

assert.equal(canNavigateToScriptStep(1, { hasAnalysis: false, hasScript: false }), true);
assert.equal(canNavigateToScriptStep(2, { hasAnalysis: true, hasScript: false }), true);
assert.equal(canNavigateToScriptStep(3, { hasAnalysis: true, hasScript: true }), true);

assert.equal(canNavigateToScriptStep(2, { hasAnalysis: false, hasScript: true }), false);
assert.equal(canNavigateToScriptStep(3, { hasAnalysis: true, hasScript: false }), false);
