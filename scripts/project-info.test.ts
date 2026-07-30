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
  /SELECT id, name, productName, productCode, productCategory FROM projects WHERE id = \?/,
);
assert.match(projectRouteSource, /project:\s*updatedProject/);

console.log('project info tests passed');
