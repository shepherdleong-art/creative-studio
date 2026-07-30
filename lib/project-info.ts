export interface ProjectInfo {
  name: string;
  productName: string;
  productCode: string;
  productCategory: string;
}

export class ProjectInfoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectInfoValidationError';
  }
}

const OPTIONAL_PROJECT_INFO_KEYS = [
  'productName',
  'productCode',
  'productCategory',
] as const;

export function parseProjectInfoUpdate(body: Record<string, unknown>): Partial<ProjectInfo> {
  const update: Partial<ProjectInfo> = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) throw new ProjectInfoValidationError('项目名称不能为空');
    update.name = name;
  }

  for (const key of OPTIONAL_PROJECT_INFO_KEYS) {
    if (typeof body[key] === 'string') update[key] = body[key].trim();
  }

  return update;
}
