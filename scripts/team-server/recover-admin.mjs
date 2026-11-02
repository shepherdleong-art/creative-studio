import { runLocalAdministratorCommand } from '../../lib/team-service/auth/local-command.ts';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : '';
}

try {
  const employeeId = argument('--employee-id');
  if (!employeeId) throw new Error('用法：node scripts/team-server/recover-admin.mjs --employee-id <既有工号>');
  const result = await runLocalAdministratorCommand('recover', { employeeId });
  console.log(`已恢复管理员 ${result.user.employeeId}。一次性凭据（仅显示本次）：${result.credential}`);
} catch (error) {
  console.error(`管理员恢复失败：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
}
