export interface ScriptTemplateDefinition {
  id: string;
  version: number;
  name: string;
  slogan: string;
  example: string;
  suitable: string;
  objective: string;
  narrativeStructure: readonly string[];
  writingRules: readonly string[];
  desiredAudienceResponse: string;
}

export const SCRIPT_TEMPLATES: readonly ScriptTemplateDefinition[] = [
  {
    id: 'pain_point',
    version: 1,
    name: '直击痛点',
    slogan: '你是不是也…？',
    example: '从用户痛点切入，再给出解决证据。',
    suitable: '功能型卖点',
    objective: '让目标用户先确认自身痛点，再用已选卖点建立可信的解决证据。',
    narrativeStructure: [
      '用具体生活场景或问题句直接点出目标人群正在经历的痛点',
      '说明痛点带来的麻烦或代价，增强解决必要性但不过度恐吓',
      '在痛点被充分识别后自然引出产品',
      '把已选卖点写成“解决机制 → 用户收益”的证据链',
      '用可感知的改善结果收束',
    ],
    writingRules: [
      '开头第一句必须出现具体痛点，不得先介绍产品',
      '不得使用未由已选卖点支持的效果、数据或承诺',
      '避免空泛的“神器”“闭眼入”，优先说明产品为什么有效',
    ],
    desiredAudienceResponse: '“这说的就是我，而且它确实解释了怎么解决。”',
  },
  {
    id: 'scene_seeding',
    version: 1,
    name: '场景种草',
    slogan: '打造让人向往的生活场景',
    example: '用具体生活场景建立代入感。',
    suitable: '颜值/氛围型',
    objective: '让目标用户先向往一个具体生活状态，再把产品写成这个场景中自然且必要的一部分。',
    narrativeStructure: [
      '交代目标人群熟悉的时间、地点和人物状态',
      '用动作或感官细节建立生活氛围与代入感',
      '让产品在场景需要中自然出现，不突然推销',
      '把已选卖点转译成场景中的具体体验改善',
      '用令人向往的生活结果或状态收束',
    ],
    writingRules: [
      '开头不得先报参数、品牌口号或促销信息',
      '场景细节必须服务目标人群和真实使用情境，避免空泛堆砌氛围词',
      '所有产品收益必须能追溯到已选卖点，禁止虚构生活效果',
    ],
    desiredAudienceResponse: '“我也想拥有这样的生活，而且这个产品确实适合这个场景。”',
  },
  {
    id: 'feature_showcase',
    version: 1,
    name: '功能展示',
    slogan: '逐项展示核心功能',
    example: '按重要性展示功能和参数证据。',
    suitable: '硬核参数型',
    objective: '按决策重要性清楚展示产品能力，并把参数和细节翻译成用户能理解的实际收益。',
    narrativeStructure: [
      '先亮出最重要且最能影响购买决策的核心功能',
      '按照卖点优先级逐项展开，原则上一段只承担一个核心功能',
      '把参数或设计细节解释成作用机制',
      '说明该机制在具体使用中给用户带来的收益',
      '用核心能力总结产品适合谁以及为什么值得选择',
    ],
    writingRules: [
      '参数、材质和功能名称必须来自已选卖点，不得补造规格',
      '每个功能都必须回答“这对用户有什么用”，不得只罗列名词',
      '优先级高的卖点必须获得更靠前、更充分的表达空间',
    ],
    desiredAudienceResponse: '“功能讲得清楚，每一项都能看懂它对我有什么价值。”',
  },
  {
    id: 'emotional',
    version: 1,
    name: '情感共鸣',
    slogan: '先讲一个故事',
    example: '用情绪和生活变化连接产品。',
    suitable: '生活方式型',
    objective: '先让目标用户在真实生活片段中感到被理解，再让产品成为情绪转折或日常陪伴。',
    narrativeStructure: [
      '从目标人群熟悉的具体生活时刻切入',
      '呈现克制而真实的情绪需要或生活张力',
      '在故事建立后让产品作为陪伴或改善契机出现',
      '通过人物动作和状态变化承载已选卖点',
      '用余味感或生活态度收束，而不是突然硬性促销',
    ],
    writingRules: [
      '情绪必须来自具体处境，避免空泛煽情和夸张苦情',
      '产品不能凭空解决人生问题，只能改善已选卖点能够支持的体验',
      '至少有一个卖点要通过人物可感知的变化被表达',
    ],
    desiredAudienceResponse: '“它理解我的生活，这个产品带来的改变也很自然。”',
  },
  {
    id: 'comparison',
    version: 1,
    name: '对比测评',
    slogan: '使用前 vs 使用后',
    example: '通过前后差异突出产品价值。',
    suitable: '有明确对比点',
    objective: '在同一使用条件下呈现前后或方案差异，让用户通过可比较的证据快速理解产品价值。',
    narrativeStructure: [
      '先定义同一个使用场景和明确的比较维度',
      '呈现使用前、传统方案或旧体验中的具体问题',
      '切换到使用产品后的对应体验',
      '围绕已选卖点逐项解释差异来自什么机制',
      '基于已经展示的差异给出克制结论',
    ],
    writingRules: [
      '对比前后必须使用同一维度，避免偷换场景或标准',
      '没有用户提供的竞品事实时，只能对比传统方案或使用前后，不得贬损具体竞品',
      '差异数据和效果必须来自已选卖点，禁止虚构测试数字',
    ],
    desiredAudienceResponse: '“比较条件公平，差异具体，所以产品优势可信。”',
  },
  {
    id: 'unboxing',
    version: 1,
    name: '开箱体验',
    slogan: '从拆包到使用全记录',
    example: '沿真实体验顺序介绍产品。',
    suitable: '安装简单/包装精致',
    objective: '沿消费者首次接触产品的时间顺序建立亲历感，并降低对包装、安装和上手体验的顾虑。',
    narrativeStructure: [
      '从收到产品或准备开箱的第一时刻开始',
      '按顺序呈现拆包、取出产品与关键细节',
      '进入安装、设置或第一次使用过程',
      '用已选卖点描述第一印象和实际体验',
      '总结产品是否符合预期以及更适合哪类用户',
    ],
    writingRules: [
      '严格按真实体验的时间顺序推进，不得跳成普通功能罗列',
      '只有已选卖点提供相关事实时才能描述包装、配件或安装步骤，否则使用中性过渡',
      '不得虚构赠品、配件数量、包装材质、安装时长或个人实测结果',
    ],
    desiredAudienceResponse: '“我像跟着体验了一遍，购买后会经历什么已经很清楚。”',
  },
  {
    id: 'problem_solving',
    version: 1,
    name: '问题解决',
    slogan: '展示问题与解决方案',
    example: '抛出问题并用产品能力解决。',
    suitable: '实用功能型',
    objective: '围绕一个具体问题完整展示解决机制、使用过程和结果证据，让产品能力形成闭环。',
    narrativeStructure: [
      '明确一个目标人群经常遇到的具体问题',
      '解释问题造成的不便或形成原因，但不编造专业结论',
      '引出产品及其对应的解决机制',
      '说明如何使用或如何发挥作用',
      '用已选卖点支持的结果验证解决是否成立',
    ],
    writingRules: [
      '整条脚本聚焦一个主问题，其他卖点只能作为解决证据',
      '不能只说“可以解决”，必须交代产品凭什么以及如何解决',
      '结果验证不得超出已选卖点，不得虚构测试或专业背书',
    ],
    desiredAudienceResponse: '“问题、方法和结果都讲通了，我知道它为什么有用。”',
  },
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
