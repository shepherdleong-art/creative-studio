import assert from 'node:assert/strict';

const { TEAM_ROUTE_POLICIES, SERVER_DELETE_SEMANTICS } = await import('../lib/team-service/route-policy.ts');

const deletePolicies = TEAM_ROUTE_POLICIES.filter((policy) => policy.method === 'DELETE');
const keys = new Set(deletePolicies.map((policy) => `${policy.route} DELETE`));

for (const policy of deletePolicies) {
  const key = `${policy.route} DELETE`;
  assert.ok(
    Object.hasOwn(SERVER_DELETE_SEMANTICS, key),
    `DELETE 入口未分类：${key}；持久生产资源必须登记为 soft，其它语义必须显式列入例外。`,
  );
  if (policy.category === 'resource') {
    assert.equal(
      SERVER_DELETE_SEMANTICS[key] === 'soft' || SERVER_DELETE_SEMANTICS[key] === 'exceptional',
      true,
      `${key} 必须是 soft 或 exceptional`,
    );
  }
}

for (const key of Object.keys(SERVER_DELETE_SEMANTICS)) {
  assert.ok(keys.has(key), `删除语义引用了不存在的路由：${key}`);
}

const softRoutes = Object.entries(SERVER_DELETE_SEMANTICS)
  .filter(([, value]) => value === 'soft')
  .map(([key]) => key);
for (const required of [
  '/api/scene-references/[id] DELETE',
  '/api/shot-sets/[id] DELETE',
  '/api/video-reference-assets/[id] DELETE',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/[assetId] DELETE',
  '/api/final-edit-variants/[id] DELETE',
  '/api/final-edit/title-presets/[id] DELETE',
  '/api/video-prompt-templates/[id] DELETE',
]) {
  assert.ok(softRoutes.includes(required), `${required} 必须走软删除`);
}
for (const required of [
  '/api/projects/[id]/script-generation DELETE',
  '/api/batch-production/scripts DELETE',
]) {
  assert.ok(!softRoutes.includes(required), `${required} 是显式例外，不得误改为回收站资源`);
}

console.log(`team delete coverage passed (${deletePolicies.length} DELETE routes classified)`);
