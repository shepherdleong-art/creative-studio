import { runLocalAdministratorCommand } from '../../lib/team-service/auth/local-command.ts';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : '';
}

try {
  const employeeId = argument('--employee-id');
  if (!employeeId) throw new Error('用法：node scripts/team-server/init-admin.mjs --employee-id <工号> [--name <姓名>]');
  const result = await runLocalAdministratorCommand('initialize', {
    employeeId,
    displayName: argument('--name') || '系统管理员',
  });
  console.log(`已初始化首管理员 ${result.user.employeeId}。一次性凭据（仅显示本次）：${result.credential}`);
} catch (error) {
  console.error(`首管理员初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
}
