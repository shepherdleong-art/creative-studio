export interface ScriptTemplateDefinition {
  id: string;
  name: string;
  slogan: string;
  example: string;
  suitable: string;
}

export const SCRIPT_TEMPLATES: readonly ScriptTemplateDefinition[] = [
  { id: 'pain_point', name: '直击痛点', slogan: '你是不是也…？', example: '从用户痛点切入，再给出解决证据。', suitable: '功能型卖点' },
  { id: 'scene_seeding', name: '场景种草', slogan: '打造让人向往的生活场景', example: '用具体生活场景建立代入感。', suitable: '颜值/氛围型' },
  { id: 'feature_showcase', name: '功能展示', slogan: '逐项展示核心功能', example: '按重要性展示功能和参数证据。', suitable: '硬核参数型' },
  { id: 'emotional', name: '情感共鸣', slogan: '先讲一个故事', example: '用情绪和生活变化连接产品。', suitable: '生活方式型' },
  { id: 'comparison', name: '对比测评', slogan: '使用前 vs 使用后', example: '通过前后差异突出产品价值。', suitable: '有明确对比点' },
  { id: 'unboxing', name: '开箱体验', slogan: '从拆包到使用全记录', example: '沿真实体验顺序介绍产品。', suitable: '安装简单/包装精致' },
  { id: 'problem_solving', name: '问题解决', slogan: '展示问题与解决方案', example: '抛出问题并用产品能力解决。', suitable: '实用功能型' },
] as const;

export const DEFAULT_SCRIPT_TEMPLATE_ID = 'scene_seeding';

export function getScriptTemplate(templateId: string): ScriptTemplateDefinition | undefined {
  return SCRIPT_TEMPLATES.find((template) => template.id === templateId);
}

export function chooseFallbackScriptTemplate(platform: string): ScriptTemplateDefinition {
  if (/抖音|快手/u.test(platform)) return getScriptTemplate('pain_point')!;
  if (/小红书|视频号/u.test(platform)) return getScriptTemplate('scene_seeding')!;
  return getScriptTemplate(DEFAULT_SCRIPT_TEMPLATE_ID)!;
}
