const node = (file, matrixIds, options = {}) => ({
  name: file,
  command: [process.execPath, `scripts/${file}`],
  displayCommand: `node scripts/${file}`,
  matrixIds,
  timeoutMs: 180_000,
  ...options,
});
const npm = (script, matrixIds, options = {}) => ({
  name: script,
  command: [process.platform === 'win32' ? 'npm.cmd' : 'npm', 'run', script],
  displayCommand: `npm run ${script}`,
  matrixIds,
  timeoutMs: 600_000,
  ...options,
});

export const MATRIX_IDS = [
  'A01', 'A02', 'A03', 'A04', 'A05', 'F01', 'F02', 'F03', 'F04', 'F05',
  'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10',
  'C01', 'R01', 'R02', 'R03', 'R04', 'U01', 'U02', 'U03', 'U04',
  'O01', 'O02', 'O03', 'B01', 'B02', 'B03', 'B04',
  'W01', 'W02', 'W03', 'W04',
];

export const L1_SUITE = [
  node('team-auth.test.ts', ['A03']),
  node('team-auth-route.test.ts', ['A03', 'A04']),
  node('team-auth-bootstrap.test.ts', ['A03']),
  node('team-api-auth-matrix.test.ts', ['A01', 'A04', 'A05', 'O03']),
  node('team-resource-scopes.test.ts', ['A01', 'A02']),
  node('team-atomic-create.test.ts', ['A02']),
  node('team-api-coverage.test.mjs', ['A04']),
  node('team-files.test.ts', ['A05', 'F01']),
  node('team-file-routes.test.ts', ['A04', 'F01']),
  node('file-response.test.ts', ['F01', 'F04']),
  node('team-public-resources.test.ts', ['A05']),
  node('team-public-resource-candidates.test.ts', ['A05']),
  node('team-transfers.test.ts', ['F02', 'F03']),
  node('team-transfer-routes.test.ts', ['A01', 'F01', 'F02', 'F04']),
  node('team-transfer-space.test.ts', ['F02']),
  node('team-devices.test.ts', ['F04']),
  node('team-delivery-publication.test.ts', ['F04', 'F05']),
  node('team-lifecycle.test.ts', ['F05']),
  node('team-lifecycle-cleanup.test.ts', ['F05']),
  node('team-lifecycle-routes.test.ts', ['F05']),
  node('execution-admission.test.ts', ['Q01', 'Q02', 'Q03', 'Q09']),
  node('execution-admission-contention.test.ts', ['Q02', 'Q09', 'Q10']),
  node('execution-operations.test.ts', ['Q04', 'Q05']),
  node('execution-attempts.test.ts', ['Q04', 'Q05', 'Q06', 'Q10']),
  node('execution-journal.test.ts', ['Q04', 'B03']),
  node('execution-reconciliation.test.ts', ['Q04', 'Q05', 'Q10', 'B03']),
  node('execution-team-context.test.ts', ['A01', 'Q01', 'Q05']),
  node('team-acceptance-fairness.test.ts', ['Q02']),
  node('legacy-media-execution.test.ts', ['Q01', 'Q04', 'Q07']),
  node('script-provider-execution.test.ts', ['Q01', 'Q06', 'Q08']),
  node('media-speech-execution.test.ts', ['Q01', 'Q06']),
  node('creative-canvas-execution.test.ts', ['C01', 'Q01', 'Q08']),
  node('creative-canvas-recovery.test.ts', ['C01', 'Q08']),
  node('creative-canvas-external-recovery.test.ts', ['C01', 'Q04']),
  node('script-generation-persistence.test.ts', ['Q08']),
  node('script-generation-manager.test.ts', ['Q06', 'Q08']),
  node('script-generation-route.test.ts', ['Q08']),
  node('script-studio-runner.test.ts', ['Q03', 'Q06', 'Q08']),
  node('script-studio-request-budget.test.ts', ['Q06', 'Q09']),
  node('script-studio-scheduler-version.test.ts', ['Q08']),
  node('batch-scheduler.test.ts', ['Q03', 'Q08']),
  node('batch-executors.test.ts', ['Q01', 'Q06']),
  node('batch-narration-seam.test.ts', ['Q06']),
  node('batch-render-narration-gate.test.ts', ['Q07']),
  node('media-resource-gate.test.ts', ['Q07']),
  node('video-browser-preview-jobs.test.ts', ['Q07']),
  node('final-edit-startup-recovery.test.ts', ['Q08']),
  node('team-runtime-owner.test.ts', ['R01']),
  node('team-service-bootstrap.test.ts', ['R01']),
  node('team-instrumentation.test.ts', ['R01']),
  node('team-server-entry.test.ts', ['R01', 'R03']),
  node('graceful-shutdown.test.ts', ['R03']),
  node('team-diagnostics.test.ts', ['O01', 'O02']),
  node('team-usage-routes.test.ts', ['O01', 'O02', 'O03']),
  node('team-usage-admin.test.ts', ['O02', 'O03']),
  node('team-maintenance-backup.test.ts', ['B01']),
  node('team-maintenance-rotation.test.ts', ['B02']),
  node('team-maintenance-restore.test.ts', ['B03']),
  node('team-maintenance-release.test.ts', ['B01']),
];

export const FIRST_RUN_SUITE = [
  node('team-first-run.test.ts', ['A01', 'A03', 'Q01', 'Q02']),
  node('creative-canvas-execution.test.ts', ['C01', 'Q01', 'Q08']),
  node('batch-executors.test.ts', ['Q01', 'Q03', 'Q06']),
  node('script-studio-runner.test.ts', ['Q03', 'Q06', 'Q08']),
  node('final-edit-render.test.ts', ['Q07']),
  node('team-maintenance-runner.test.ts', ['B01', 'B03']),
  node('team-client-update-hosting.test.mjs', ['U02', 'U03']),
];

export const L2_SUITE = [
  npm('build:desktop', ['U01', 'U02', 'U03']),
  node('team-acceptance-http.playwright.test.mjs', ['A01', 'A03', 'A04', 'F01', 'F02', 'F03', 'F04', 'O01', 'O03', 'Q02', 'R03', 'U04'], {
    timeoutMs: 900_000,
    realMedia: true,
  }),
  node('team-upload-business-publication.test.ts', ['A02', 'F02', 'F03', 'Q07'], {
    timeoutMs: 300_000,
    realMedia: true,
  }),
  node('team-client-remote-transfer.test.mjs', ['F04', 'U01']),
  node('team-client-updater.test.mjs', ['U02', 'U03', 'U04']),
  node('team-client-update-process.test.mjs', ['U02', 'U03']),
  node('team-client-capabilities.test.ts', ['U04']),
  node('team-server-operations.test.ts', ['R03']),
  node('team-transfer-space.test.ts', ['F02']),
  node('team-maintenance-runner.test.ts', ['B01', 'B03']),
];

export const LOCAL_CHECKS = [
  npm('lint', ['A04']),
  npm('build', ['R01', 'R04']),
  npm('check:main-path', ['Q01', 'Q07', 'Q08', 'C01']),
  node('python-runtime-windows.test.mjs', ['R04']),
  node('company-provider-startup.test.mjs', ['R03']),
  node('windows-portable-payload.test.mjs', ['U01']),
  node('standalone-desktop-boundary.test.mjs', ['U01']),
  node('team-server-package-boundary.test.mjs', ['R01', 'R04']),
  node('team-client-package-boundary.test.mjs', ['U01']),
  node('team-acceptance-harness.test.mjs', ['O01']),
];

/**
 * 界面尺寸验收（第 04 号票，林视界面重设计）。矩阵项 W01–W04 是本套件新增的：
 *   W01 从 1536×864 到 1024×720 都不横向滚动；W02 控件不被切掉、工具栏不藏内容；
 *   W03 视频画面比例正确且够大；W04 浅色深色两主题都成立。
 * 只跑它：node scripts/team-server/acceptance.mjs --level ui
 */
export const UI_SUITE = [
  node('ui-acceptance-checks.test.mjs', ['W01', 'W02', 'W03', 'W04']),
  node('ui-acceptance.playwright.test.mjs', ['W01', 'W02', 'W03', 'W04'], {
    timeoutMs: 3_600_000,
    realMedia: true,
    uiAcceptance: true,
  }),
];

export const ONSITE_GAPS = [
  { level: 'L3', matrixIds: ['R02'], name: '目标 Windows 服务账号、SCM、无人登录与异常重启', reason: '缺少目标 Windows Server、服务账号与 SCM 现场', entry: '部署手册 D05/D07' },
  { level: 'L3', matrixIds: ['R03'], name: '现场 LiteLLM 与受控进程树', reason: '本地故障注入不能替代目标 SCM 服务账号验收', entry: '部署手册 D07' },
  { level: 'L3', matrixIds: ['R04'], name: '服务账号 NVENC、CPU 回退与媒体资源', reason: '缺少目标 3060/GPU 驱动、服务账号和正式资源包现场', entry: '部署手册 D02/D07' },
  { level: 'L3', matrixIds: ['F04', 'U01', 'U02', 'U03'], name: '两台物理设备与可信内网更新', reason: '逻辑设备与原生进程测试不代替两台物理设备、正式签名和证书信任', entry: '部署手册 D08' },
  { level: 'L3', matrixIds: ['B01', 'B02', 'B04'], name: '独立故障域备份与现场回退', reason: '缺少目标备份故障域和现场发布权限', entry: '部署手册 D05/D09' },
  { level: 'L4', matrixIds: ['B02'], name: '连续完整工作日运行与每日备份', reason: '短烟测不能替代连续工作日资源曲线、日志增长和每日作业证据', entry: '目标部署连续运行至少一个完整工作日后执行 acceptance.mjs --level onsite 并附现场记录' },
  { level: 'L4', matrixIds: ['Q07', 'Q02'], name: '媒体逐级容量、完整 60 分钟与 20 用户控制面容量签收', reason: '短烟测只验证驱动和机制，不是目标主机容量签收', entry: 'node scripts/team-server/acceptance.mjs --level L2 --config scripts/team-server/acceptance-capacity.json' },
  { level: 'L4', matrixIds: ['A01', 'C01', 'O01'], name: '负责人和另一同事四模块试点', reason: '自动测试不冒充两人物理试点', entry: '部署手册 D08，两人分别执行验收矩阵并签名' },
  { level: 'L3', matrixIds: ['Q04', 'Q06', 'Q10'], name: '已授权真实供应商小样本', reason: '本地 fake transport 不产生真实付费证据；预算与素材尚待现场批准', entry: '部署手册 D02/D08，使用已批准模型、素材和预算' },
];
