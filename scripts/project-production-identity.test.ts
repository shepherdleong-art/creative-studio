import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { ProjectProductionIdentity, ProductionIdentityFields } from '../lib/project-production-identity.ts';
import {
  STORE_CODES,
  PRODUCTION_TYPES,
  normalizeIdentityText,
  parseProductionIdentityInput,
  buildProjectBaseName,
  formatShanghaiIdentityDate,
  resolveUniqueProjectBaseName,
  assertSafeIdentityName,
} from '../lib/project-production-identity.ts';
import { ProjectInfoValidationError } from '../lib/project-info.ts';
import { ProjectIdentityError } from '../lib/project-production-identity.ts';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  return db;
}

// 1. 空子型号:名称中只出现一次型号
{
  const identity: ProjectProductionIdentity = {
    namingDate: '20260815', storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷',
  };
  assert.equal(buildProjectBaseName(identity), '20260815-B店-XQ9A-AI种草-紫菜卷');
  assert.equal((buildProjectBaseName(identity).match(/XQ9A/g) ?? []).length, 1, '空子型号时型号只能出现一次');
}

// 2. 型号 PC672-A、空子型号:保留连字符,不拆分
{
  const identity: ProjectProductionIdentity = {
    namingDate: '20260815', storeCode: 'B店', productCode: 'PC672-A', productSubmodel: '', productionType: '新品种草', editorName: '紫菜卷',
  };
  assert.equal(buildProjectBaseName(identity), '20260815-B店-PC672-A-新品种草-紫菜卷');
}

// 3. 型号 XQ9A、子型号 A:输出 XQ9A-A
{
  const identity: ProjectProductionIdentity = {
    namingDate: '20260815', storeCode: 'B店', productCode: 'XQ9A', productSubmodel: 'A', productionType: 'AI种草', editorName: '紫菜卷',
  };
  assert.equal(buildProjectBaseName(identity), '20260815-B店-XQ9A-A-AI种草-紫菜卷');
}

// 4. 四种店铺 × 两种生产类型:均可创建且名称正确
{
  const sample: ProductionIdentityFields = {
    storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: '新品种草', editorName: '紫菜卷',
  };
  for (const store of STORE_CODES) {
    for (const type of PRODUCTION_TYPES) {
      const identity: ProjectProductionIdentity = { ...sample, storeCode: store, productionType: type, namingDate: '20260815' };
      const name = buildProjectBaseName(identity);
      assert.ok(name.startsWith(`20260815-${store}-XQ9A-${type}-`), `店铺/生产类型组合命名错误: ${name}`);
    }
  }
}

// 5. 名称含内部空格与内部连字符可保留
{
  const identity: ProjectProductionIdentity = {
    namingDate: '20260815', storeCode: '京东', productCode: 'LH122 K3', productSubmodel: '', productionType: '新品种草', editorName: '张 三',
  };
  assert.equal(buildProjectBaseName(identity), '20260815-京东-LH122 K3-新品种草-张 三');
}

// 6. parseProductionIdentityInput:归一 NFKC、首尾空白、连续空白
{
  assert.deepEqual(
    parseProductionIdentityInput({
      storeCode: ' B店 ', productCode: '　XQ9A　', productSubmodel: '  A  B  ', productionType: ' AI种草 ', editorName: '  紫菜卷  ',
    }),
    { storeCode: 'B店', productCode: 'XQ9A', productSubmodel: 'A B', productionType: 'AI种草', editorName: '紫菜卷' },
  );
}

// 7. 非法店铺 / 非法生产类型
{
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: '天猫-B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError && /店铺仅支持/.test(error.message),
  );
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productionType: '带货', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError && /生产类型仅支持/.test(error.message),
  );
}

// 8. 必填字段为空
{
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: '  ', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError && /型号不能为空/.test(error.message),
  );
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '' }),
    (error: unknown) => error instanceof ProjectInfoValidationError && /剪辑师不能为空/.test(error.message),
  );
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: '', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError && /店铺仅支持/.test(error.message),
  );
}

// 9. 非法字符在 API 层拒绝,不静默改写成不可识别的身份
{
  const forbidden = ['A/B', 'A\\B', 'A:B', 'A*B', 'A?B', 'A"B', 'A<B', 'A>B', 'A|B', '.', '..'];
  for (const bad of forbidden) {
    assert.throws(
      () => parseProductionIdentityInput({ storeCode: 'B店', productCode: bad, productionType: 'AI种草', editorName: '紫菜卷' }),
      (error: unknown) => error instanceof ProjectInfoValidationError,
      `型号 ${JSON.stringify(bad)} 应当被拒绝`,
    );
  }
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: '..', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError,
    '型号 .. 应当被拒绝',
  );
  // 内部点号不是非法字符,保留
  assert.equal(
    parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A.1', productionType: 'AI种草', editorName: '紫菜卷' }).productCode,
    'XQ9A.1',
  );
}

// 10. 日期冻结:命名日期格式必须为 YYYYMMDD
{
  assert.throws(
    () => buildProjectBaseName({ namingDate: '2026-8-15', storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError,
  );
}

// 11. 上海时区日期格式化
{
  // 2026-08-15 23:30 UTC = 2026-08-16 07:30 上海
  const name = formatShanghaiIdentityDate(new Date('2026-08-15T23:30:00Z'));
  assert.equal(name, '20260816', '应按上海时区跨天计算');
  assert.equal(formatShanghaiIdentityDate(new Date('2026-08-15T12:00:00Z')), '20260815');
}

// 12. 同名项目碰撞消解:追加 -02、-03,且不覆盖既有
{
  const db = makeDb();
  db.prepare(`INSERT INTO projects (id, name) VALUES ('a', '20260815-B店-XQ9A-AI种草-紫菜卷')`).run();
  db.prepare(`INSERT INTO projects (id, name) VALUES ('b', '20260815-B店-XQ9A-AI种草-紫菜卷-02')`).run();
  assert.equal(resolveUniqueProjectBaseName(db, '20260815-B店-XQ9A-AI种草-紫菜卷'), '20260815-B店-XQ9A-AI种草-紫菜卷-03');
  assert.equal(resolveUniqueProjectBaseName(db, '20260815-B店-XQ9A-AI种草-紫菜卷-02'), '20260815-B店-XQ9A-AI种草-紫菜卷-02-02');
  assert.equal(
    resolveUniqueProjectBaseName(db, '20260815-B店-XQ9A-AI种草-紫菜卷', 'a'),
    '20260815-B店-XQ9A-AI种草-紫菜卷',
    '排除自身占用后基础名本身可用',
  );
  db.close();
}

// 13. 无碰撞时不加后缀
{
  const db = makeDb();
  assert.equal(resolveUniqueProjectBaseName(db, '20260815-K店-RQ5A-AI种草-紫菜卷'), '20260815-K店-RQ5A-AI种草-紫菜卷');
  db.close();
}

// 14. 路径安全守卫:允许中文/字母/数字/内部连字符/内部空格/点/下划线,拒绝路径分隔符
{
  assert.doesNotThrow(() => assertSafeIdentityName('20260815-B店-XQ9A-A-新品种草-张 三'));
  assert.throws(() => assertSafeIdentityName(''), (error: unknown) => error instanceof ProjectIdentityError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeIdentityName('..'), (error: unknown) => error instanceof ProjectIdentityError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeIdentityName('a/b'), (error: unknown) => error instanceof ProjectIdentityError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeIdentityName('a\\b'), (error: unknown) => error instanceof ProjectIdentityError && error.code === 'unsafe_path');
  assert.throws(() => assertSafeIdentityName('a\0b'), (error: unknown) => error instanceof ProjectIdentityError && error.code === 'unsafe_path');
}

// 15. 归一函数
{
  assert.equal(normalizeIdentityText('  XQ9A\t\n   PC672-A  '), 'XQ9A PC672-A');
  assert.equal(normalizeIdentityText('　全角　空格　'), '全角 空格');
}

console.log('project-production-identity tests passed');
