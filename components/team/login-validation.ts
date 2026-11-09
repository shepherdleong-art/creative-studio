// 登录表单的本地校验：空工号、空密码、新密码太短、两次不一致。
//
// 抽成不依赖 React 的纯函数，好处是规则可以被单测直接钉死，也保证四种提示
// 各自落到对应字段（渲染在输入框旁，而不是一条总错误或浏览器弹窗）。
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

export type LoginFieldName = 'employeeId' | 'currentPassword' | 'newPassword' | 'confirmation';
export type LoginFieldErrors = Partial<Record<LoginFieldName, string>>;

export interface LoginValidationInput {
  mode: 'login' | 'change';
  employeeId: string;
  currentPassword: string;
  newPassword: string;
  confirmation: string;
}

export function validateLoginFields(input: LoginValidationInput): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  if (input.mode === 'login') {
    if (!input.employeeId.trim()) errors.employeeId = '请输入工号';
    if (!input.currentPassword) errors.currentPassword = '请输入密码';
    return errors;
  }
  if (!input.newPassword) errors.newPassword = '请设置新密码';
  else if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    errors.newPassword = `新密码至少 ${MIN_PASSWORD_LENGTH} 位，可以使用 ${MIN_PASSWORD_LENGTH} 位数字`;
  } else if (input.newPassword.length > MAX_PASSWORD_LENGTH) {
    errors.newPassword = `新密码不能超过 ${MAX_PASSWORD_LENGTH} 位`;
  }
  if (!input.confirmation) errors.confirmation = '请再输入一次新密码';
  else if (input.confirmation !== input.newPassword) errors.confirmation = '两次输入的新密码不一致';
  return errors;
}
