import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_PROMPT_MAX,
  normalizeVideoPromptTemplateInput,
} from '../lib/video-prompt-template.ts';

const good = {
  name: '慢速左推',
  description: '贴着左侧推进',
  prompt: '以当前图片为首帧，镜头向左前方缓慢推进。不要添加文字。',
};

// ── 正常输入 ──────────────────────────────────────────────────────────
{
  const result = normalizeVideoPromptTemplateInput(good);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.name, '慢速左推');
  assert.equal(result.value.inRandomPool, true, '不写 inRandomPool 时默认入池');
  assert.deepEqual(result.warnings, [], '写全了首帧和禁字就不该有告警');
}

{
  const result = normalizeVideoPromptTemplateInput({ ...good, inRandomPool: false });
  assert.equal(result.ok && result.value.inRandomPool, false, '显式关闭必须被尊重');
}

{
  const result = normalizeVideoPromptTemplateInput({
    name: '  带空格  ',
    description: '  也带  ',
    prompt: `  ${good.prompt}  `,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.name, '带空格', '首尾空格必须去掉');
  assert.equal(result.value.description, '也带');
  assert.equal(result.value.prompt, good.prompt);
}

// ── 硬性错误 ──────────────────────────────────────────────────────────
for (const [label, body] of [
  ['名称为空', { ...good, name: '   ' }],
  ['提示词为空', { ...good, prompt: '' }],
  ['名称超长', { ...good, name: '字'.repeat(TEMPLATE_NAME_MAX + 1) }],
  ['描述超长', { ...good, description: '字'.repeat(TEMPLATE_DESCRIPTION_MAX + 1) }],
  ['提示词超长', { ...good, prompt: '字'.repeat(TEMPLATE_PROMPT_MAX + 1) }],
] as const) {
  const result = normalizeVideoPromptTemplateInput(body);
  assert.equal(result.ok, false, `${label} 必须被拒绝`);
  if (result.ok) throw new Error('unreachable');
  assert.ok(result.error.length > 0, `${label} 必须给出可读的原因`);
}

for (const bad of [null, undefined, 'string', 42]) {
  assert.equal(normalizeVideoPromptTemplateInput(bad).ok, false, '非对象输入必须被拒绝');
}

// 边界值本身是合法的，不能误伤。
{
  const atLimit = normalizeVideoPromptTemplateInput({
    name: '字'.repeat(TEMPLATE_NAME_MAX),
    description: '字'.repeat(TEMPLATE_DESCRIPTION_MAX),
    prompt: '以当前图片为首帧'.padEnd(TEMPLATE_PROMPT_MAX, '字'),
  });
  assert.equal(atLimit.ok, true, '正好到上限应当放行');
}

// ── 写法建议只告警、不拦提交 ──────────────────────────────────────────
// 提示词怎么写是用户的判断，我们不替他决定；但这两条漏了确实会出问题，
// 所以要如实提醒。
{
  const result = normalizeVideoPromptTemplateInput({ ...good, prompt: '镜头随便动动。' });
  assert.equal(result.ok, true, '缺少建议项不得拦下提交');
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.includes('以当前图片为首帧')), '缺首帧要提醒');
  assert.ok(result.warnings.some((w) => w.includes('不要添加文字')), '缺禁字要提醒');
}

{
  const onlyHead = normalizeVideoPromptTemplateInput({ ...good, prompt: '以当前图片为首帧，随便动动。' });
  assert.equal(onlyHead.ok && onlyHead.warnings.length, 1, '只缺一条就只报一条');
}

// ── 路由必须守住的几件事 ──────────────────────────────────────────────
const itemRoute = fs.readFileSync('app/api/video-prompt-templates/[id]/route.ts', 'utf8');
const listRoute = fs.readFileSync('app/api/video-prompt-templates/route.ts', 'utf8');

assert.match(
  listRoute,
  /'camera_motion',\s*0\s*,/,
  '新建的模板必须写成自定义（isBuiltin = 0），否则会被 seed 当成内置行覆盖',
);
assert.match(listRoute, /已有同名模板/, '重名必须挡下，否则下拉里分不清');
assert.match(itemRoute, /内置模板不可编辑/, '内置模板的内容必须只读');
assert.match(itemRoute, /内置模板不能删除/, '内置模板不可删除——seed 会把它补回来');
assert.match(
  itemRoute,
  /SELECT COUNT\(\*\) AS count FROM video_jobs WHERE templateId = \?/,
  '删除前必须查引用：templateId 是外键，被引用的模板删了会断掉历史任务的出处',
);
assert.doesNotMatch(
  itemRoute,
  /UPDATE video_prompt_templates\s+SET name[\s\S]{0,400}isBuiltin = 1/,
  '不得存在绕过只读限制、直接改内置模板内容的分支',
);

console.log('video prompt template tests passed');
