import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProjectInfoUpdate, ProjectInfoValidationError } from '../lib/project-info.ts';

assert.deepEqual(parseProjectInfoUpdate({
  name: '  七月-床  ',
  productName: '  舒适软床 ',
  productCode: ' RQ1A-1 ',
  productCategory: ' 家居 / 床具 ',
}), {
  name: '七月-床',
  productName: '舒适软床',
  productCode: 'RQ1A-1',
  productCategory: '家居 / 床具',
});

assert.deepEqual(parseProjectInfoUpdate({
  productName: '  ',
  productCode: '',
  productCategory: ' 床具 ',
}), {
  productName: '',
  productCode: '',
  productCategory: '床具',
});

assert.throws(
  () => parseProjectInfoUpdate({ name: '   ' }),
  (error: unknown) => error instanceof ProjectInfoValidationError
    && error.message === '项目名称不能为空',
);

const projectRouteSource = readFileSync(
  new URL('../app/api/projects/[id]/route.ts', import.meta.url),
  'utf8',
);

assert.match(projectRouteSource, /parseProjectInfoUpdate\(body\)/);
assert.match(projectRouteSource, /ProjectInfoValidationError/);
assert.match(
  projectRouteSource,
  /SELECT id, name, productName, productCode, productCategory, storeCode, productSubmodel, productionType, editorName, namingDate FROM projects WHERE id = \?/,
);
assert.match(
  projectRouteSource,
  /lastOpenedAt IS NULL OR lastOpenedAt < datetime\(['"]now['"], ['"]-60 seconds['"]\)/,
  '项目详情轮询不得每次都写入 lastOpenedAt',
);
assert.match(projectRouteSource, /project:\s*updatedProject/);
// 生产身份：PATCH 必须走领域字段解析并重新生成名称，冻结后返回 409
assert.match(projectRouteSource, /parseProductionIdentityUpdate\(body\)/);
assert.match(projectRouteSource, /export_identity_frozen/);
assert.match(projectRouteSource, /ENABLE_NEW_EXPORT_IDENTITY_KEY/, '确认字段必须走共享常量，与弹窗契约一致');
assert.match(projectRouteSource, /hasExportIdentity\(db, id\)/);

console.log('project info tests passed');
