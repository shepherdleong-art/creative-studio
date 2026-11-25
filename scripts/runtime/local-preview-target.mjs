import fs from 'node:fs';
import path from 'node:path';

export function localPreviewTarget(root, useDefault = false) {
  const home = path.join(root, 'outputs', 'local-preview');
  const profile = path.join(home, 'project.json');
  if (useDefault || !fs.existsSync(profile)) {
    return { appRoot: root, dataRoot: home, deploymentId: 'windows-local-preview', port: 3410, projectId: '' };
  }
  const { sourceRoot = '.', dataRoot, projectId, port = 3410 } = JSON.parse(fs.readFileSync(profile, 'utf8'));
  if (!dataRoot || typeof projectId !== 'string' || !/^[\w-]+$/.test(projectId)
      || !Number.isInteger(port) || port < 1 || port > 64535) {
    throw new Error('本地预览的 project.json 需要已有项目的数据目录、项目 ID 和有效端口。');
  }
  const projectRoot = path.resolve(root, dataRoot);
  if (!fs.existsSync(path.join(projectRoot, 'data', 'workbench.db'))) throw new Error('找不到原项目的 workbench.db。');
  const marker = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'deployment.json'), 'utf8'));
  if (marker.mode !== 'server' || marker.version !== 1 || typeof marker.deploymentId !== 'string' || !marker.deploymentId.trim()) {
    throw new Error('原项目的团队部署标识无效。');
  }
  return { appRoot: path.resolve(root, sourceRoot), dataRoot: projectRoot, deploymentId: marker.deploymentId, port, projectId };
}
