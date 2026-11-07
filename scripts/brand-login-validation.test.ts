// 登录表单校验规则：四种提示必须各自落到对应字段，且文案可被验收脚本断言。
// 纯函数，不依赖 React，改规则时先改这里的断言。
import assert from 'node:assert/strict';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateLoginFields,
} from '../components/team/login-validation.ts';

const base = { mode: 'login' as const, employeeId: '', currentPassword: '', newPassword: '', confirmation: '' };

// ① 空工号 + ② 空密码：两条同时报，各归各的字段。
assert.deepEqual(validateLoginFields(base), {
  employeeId: '请输入工号',
  currentPassword: '请输入密码',
});

assert.deepEqual(
  validateLoginFields({ ...base, employeeId: '0102', currentPassword: 'x' }),
  {},
  '填全后登录模式不应有字段错误',
);

// 只有空格也算空工号。
assert.equal(validateLoginFields({ ...base, employeeId: '   ', currentPassword: 'x' }).employeeId, '请输入工号');

// ③ 新密码太短（改密模式）。
const changeBase = { mode: 'change' as const, employeeId: '', currentPassword: 'once', newPassword: '', confirmation: '' };
const tooShort = validateLoginFields({ ...changeBase, newPassword: '123', confirmation: '123' });
assert.equal(tooShort.newPassword, `新密码至少 ${MIN_PASSWORD_LENGTH} 位，可以使用 ${MIN_PASSWORD_LENGTH} 位数字`);
assert.equal(tooShort.confirmation, undefined, '两次一致时不应报不一致');
assert.equal(tooShort.currentPassword, undefined);

// 刚好 6 位可以通过（6 位纯数字是允许的）。
assert.deepEqual(
  validateLoginFields({ ...changeBase, newPassword: '123456', confirmation: '123456' }),
  {},
  '6 位数字必须是合法新密码',
);

// 上限仍然拦。
const tooLong = validateLoginFields({
  ...changeBase, newPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1), confirmation: 'a'.repeat(MAX_PASSWORD_LENGTH + 1),
});
assert.equal(tooLong.newPassword, `新密码不能超过 ${MAX_PASSWORD_LENGTH} 位`);

// ④ 两次不一致。
const mismatch = validateLoginFields({ ...changeBase, newPassword: '123456', confirmation: '1234567' });
assert.deepEqual(mismatch, { confirmation: '两次输入的新密码不一致' });

// 改密模式下空当前密码也要报。
assert.equal(
  validateLoginFields({ ...changeBase, currentPassword: '', newPassword: '123456', confirmation: '123456' }).currentPassword,
  '请输入当前密码',
);

// 没填新密码 / 没填确认 → 各自的空值提示，优先级高于长度与不一致。
assert.deepEqual(
  validateLoginFields({ ...changeBase, newPassword: '', confirmation: '' }),
  { newPassword: '请设置新密码', confirmation: '请再输入一次新密码' },
);

console.log('login validation tests passed');
