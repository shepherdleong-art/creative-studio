import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';
import { readTeamModuleSwitches } from '@/lib/team-service/module-switches';
import TeamProductionControl from '@/components/team/TeamProductionControl';
import TeamReleaseUpload from '@/components/team/TeamReleaseUpload';

export const dynamic = 'force-dynamic';

/**
 * 运维入口说明页：只展示真实脚本路径与当前模块开关，不提供任意命令执行按钮。
 * 危险动作（安装、发布、恢复、永久清理）继续由受控 PowerShell 脚本完成。
 */
export default async function TeamOperationsPage() {
  if (readRuntimeConfig().mode !== 'server') redirect('/');
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const principal = token ? getTeamAuthService().resolveSession(token) : null;
  if (!principal || principal.mustChangePassword) redirect('/team/login');
  if (principal.role !== 'admin') redirect('/');
  const modules = readTeamModuleSwitches();
  const rows = [
    { name: '批量生产', key: 'batch', state: modules.batch },
    { name: '详情页脚本', key: 'scriptStudio', state: modules.scriptStudio },
    { name: '详情页脚本调度器', key: 'scriptStudioScheduler', state: modules.scriptStudioScheduler },
    { name: '创作画布', key: 'canvas', state: modules.canvas },
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">备份与维护</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          管理团队运行状态。暂停生成不影响成员登录、编辑和下载；备份与版本维护由服务器管理员执行。
        </p>
      </div>

      <TeamProductionControl />
      <TeamReleaseUpload />
      <section className="card p-6">
        <h2 className="text-lg font-semibold text-ink">当前模块开关</h2>
        <p className="mt-1 text-xs text-ink-tertiary">来自部署配置生成的 app.env；关闭的模块不会启动 worker，也不影响登录、编辑和下载。</p>
        <ul className="mt-4 space-y-2 text-sm">
          {rows.map((row) => <li key={row.key} className="flex items-center justify-between border-b border-hairline pb-2 last:border-0">
            <span className="text-ink-secondary">{row.name}</span>
            <span className={row.state ? 'text-ok' : 'text-warn'}>{row.state ? '已启用' : '已关闭'}</span>
          </li>)}
        </ul>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-lg font-semibold text-ink">运维脚本（在服务器上以管理员运行）</h2>
        <ul className="space-y-2 text-sm text-ink-secondary">
          <li><code className="rounded bg-surface-subtle px-1 font-mono text-xs">status.ps1 -ConfigPath &lt;deployment.json&gt; -Apply</code>：读取实例 ready、SCM 与模块状态。</li>
          <li><code className="rounded bg-surface-subtle px-1 font-mono text-xs">backup.ps1 -ConfigPath &lt;deployment.json&gt; -Type daily -Apply</code>：执行一致性备份；每日计划任务由 schedule-backup.ps1 注册。</li>
          <li><code className="rounded bg-surface-subtle px-1 font-mono text-xs">release.ps1 -ConfigPath &lt;deployment.json&gt; -NewReleaseId &lt;new&gt; -OperationId &lt;唯一操作ID&gt; -Apply</code>：切换发布指针。</li>
          <li><code className="rounded bg-surface-subtle px-1 font-mono text-xs">restore.ps1 -ConfigPath &lt;deployment.json&gt; -BackupType daily -BackupId &lt;备份ID&gt; -RestoreRoot &lt;新目录&gt; -Apply</code>：恢复到独立新根，完成对账前保持禁新付费。</li>
          <li><code className="rounded bg-surface-subtle px-1 font-mono text-xs">stop.ps1 -ConfigPath &lt;deployment.json&gt; -Apply</code>：先应用受控停机，再按依赖顺序停止 Caddy/LiteLLM。</li>
        </ul>
        <p className="text-xs leading-5 text-ink-tertiary">
          备份 pin 与维护屏障有 API，但不提供面向普通用户的原始编辑器；需要时由管理员脚本或受控接口完成。
        </p>
      </section>
    </div>
  );
}
