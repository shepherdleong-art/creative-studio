import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const childFlag = 'CREATIVE_STUDIO_MOTION_TEMPLATE_SEED_TEST_CHILD';

if (process.env[childFlag] !== '1') {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader',
    pathToFileURL(path.resolve('scripts/typescript-extension-loader.mjs')).href,
    '--experimental-strip-types',
    fileURLToPath(import.meta.url),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, [childFlag]: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} else {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-motion-template-seed-'));
  process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
  let closeDatabase: (() => void) | undefined;

  interface TemplateRow {
    id: string;
    name: string;
    description: string;
    prompt: string;
    category: string;
    isBuiltin: number;
    inRandomPool: number;
  }

  try {
    const { closeDb, getDb } = await import('../lib/db.ts');
    const { seedMotionTemplates } = await import('../lib/seed.ts');
    closeDatabase = closeDb;

    seedMotionTemplates();
    const db = getDb();
    const readAll = (): TemplateRow[] =>
      db.prepare('SELECT id, name, description, prompt, category, isBuiltin, inRandomPool FROM video_prompt_templates').all() as TemplateRow[];

    const templates = readAll();
    const byId = new Map(templates.map((t) => [t.id, t]));
    const names = new Set(templates.map((t) => t.name));

    // 批量填充按模板池洗牌轮转，池子大小直接决定成片的丰富度。
    assert.ok(templates.length >= 11, `运镜模板池至少 11 条，实际 ${templates.length} 条`);

    // ── 对齐视频模型自带的运镜词表 ──────────────────────────────────
    // 用模型训练过的词，比自造措辞可靠。这 10 个词一个都不能少。
    for (const term of [
      '推进', '拉远', '固定镜头', '手持镜头', '环绕',
      '围绕主体运镜', '跟随', '右摇', '上摇', '下摇',
    ]) {
      assert.ok(names.has(term), `模板池必须含词表里的「${term}」`);
      const row = templates.find((t) => t.name === term)!;
      assert.ok(
        row.prompt.includes(term.replace('镜头', '')),
        `「${term}」的提示词里要出现这个词本身，模型才吃得准`,
      );
    }

    for (const key of ['id', 'name', 'prompt'] as const) {
      const values = templates.map((t) => t[key]);
      assert.equal(new Set(values).size, values.length, `模板的 ${key} 不得重复`);
    }

    for (const t of templates) {
      // 首帧声明与禁字壳只约束参与随机填充的模板：随机洗出来的镜头必须安全；
      // 池外模板（如开头用的场景变身）是手动选用，文案按定稿原样保留。
      if (t.inRandomPool !== 0) {
        assert.ok(t.prompt.startsWith('以当前图片为首帧'), `${t.id} 必须声明首帧来源`);
        assert.match(t.prompt, /不要添加文字/, `${t.id} 必须禁止模型加字`);
      }
      assert.ok(t.description.trim().length > 0, `${t.id} 必须有描述`);
      assert.equal(t.isBuiltin, 1, `${t.id} 应播种为内置模板`);
    }

    // ── 用户自定义转内置的开头变身模板（2026-09-18）────────────────
    // 文案按用户定稿原样收录（不套运镜安全壳），默认不进随机池。
    for (const [id, name, prompt] of [
      ['carton-explosion', '纸箱爆炸', '空无一物的场景里放着一个纸箱，纸箱突然炸开，家具和软装飞出来，很快将场景布置好，变成首帧图的样子。'],
      ['bare-shell-renovation', '毛坯房变身', '延时摄影，原本空旷的毛坯房空间里几个工人忙碌装修，很快将家具和软装布置好，变成首帧图的样子。'],
      ['giant-hand-place', '手放家居', '一只大手将家具放入空白的空间里，其他家具和软装自然飞入空间，最后布置成首帧图的模样。'],
      ['magic-growth', '自然生长', '原本空白的场景里，家具和软装自然生长出来，像魔法一样，最终变成首帧图的样子。'],
    ] as const) {
      const row = byId.get(id);
      assert.ok(row, `内置池必须含「${name}」（${id}）`);
      assert.equal(row.name, name);
      assert.equal(row.prompt, prompt, `${id} 文案必须与用户定稿一致`);
      assert.equal(row.description, '开头用');
      assert.equal(row.inRandomPool, 0, `${id} 默认不参与随机填充`);
    }

    // ── 撞脸的条目必须已经退役 ──────────────────────────────────────
    // detail-push 曾是「缓慢靠近材质细节」＝和推进同一个动作；
    // 横移和左右摇、升降和上下摇也分不开，一并去掉。
    for (const retired of [
      'detail-push', 'left-to-right-slide', 'right-to-left-slide',
      'slow-pan', 'pedestal-up', 'pedestal-down', 'tilt-up-hero', 'tilt-down-overview',
    ]) {
      assert.equal(byId.has(retired), false, `${retired} 与其他条目撞脸，必须已退役`);
    }
    assert.equal([...names].filter((n) => n.includes('横移')).length, 0, '横移已被左右摇取代');

    // 池子里只放运镜：动焦点、动光这类非运镜条目已去掉。
    for (const notCameraMove of ['rack-focus', 'light-drift']) {
      assert.equal(byId.has(notCameraMove), false, `${notCameraMove} 不是运镜，不应出现在池子里`);
    }
    for (const t of templates) {
      assert.equal(t.category, 'camera_motion', `${t.id} 应统一登记为运镜`);
    }

    // 环绕与围绕主体运镜同属绕行，差别必须写死在措辞里。
    assert.match(byId.get('subtle-orbit')!.prompt, /一小段侧向弧线/, '「环绕」必须限定为小弧线');
    assert.match(byId.get('orbit-subject')!.prompt, /以主体为圆心持续绕行/, '「围绕主体运镜」必须是持续绕行');

    // ── 幂等 ────────────────────────────────────────────────────────
    seedMotionTemplates();
    assert.equal(readAll().length, templates.length, '重复播种不得增删行');

    // ── 老库能拿到修正后的内置文案 ──────────────────────────────────
    db.prepare(`UPDATE video_prompt_templates SET name = ?, prompt = ? WHERE id = 'slow-push-in'`)
      .run('慢速推进', '以当前图片为首帧，旧措辞。不要添加文字。');
    seedMotionTemplates();
    assert.equal(byId.get('slow-push-in')!.name, readAll().find((t) => t.id === 'slow-push-in')!.name,
      '老库的内置模板应被播种修正回当前文案');
    assert.equal(readAll().find((t) => t.id === 'slow-push-in')!.name, '推进');

    // ── 退役不得删掉仍被历史任务引用的模板 ──────────────────────────
    // video_jobs.templateId 是外键；被引用的模板是那条视频的出处，删不得。
    // 这里只关掉外键约束以便插入一条最小引用行，被测的是退役语句的 NOT EXISTS 守卫。
    db.prepare(`INSERT INTO video_prompt_templates (id, name, description, prompt, category, isBuiltin)
                VALUES ('detail-push', '材质细节推进', '旧的', '以当前图片为首帧，旧的。不要添加文字。', 'camera_motion', 1)`).run();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, templateId, prompt, durationSec)
                VALUES ('job-legacy','p','s','sh','img','prov','m','detail-push','用了旧模板',5)`).run();
    db.pragma('foreign_keys = ON');

    seedMotionTemplates();
    assert.ok(
      readAll().some((t) => t.id === 'detail-push'),
      '仍被历史视频任务引用的退役模板必须保留，否则外键会断',
    );

    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM video_jobs WHERE id = 'job-legacy'`).run();
    db.pragma('foreign_keys = ON');
    seedMotionTemplates();
    assert.equal(
      readAll().some((t) => t.id === 'detail-push'),
      false,
      '没人引用之后，退役模板应被清掉',
    );

    // ── 内置模板的入池开关不被播种重置 ─────────────────────────────
    // inRandomPool 只随 INSERT 给初始值，用户在面板里的手动开关必须存活。
    db.prepare(`UPDATE video_prompt_templates SET inRandomPool = 1 WHERE id = 'carton-explosion'`).run();
    seedMotionTemplates();
    assert.equal(readAll().find((t) => t.id === 'carton-explosion')!.inRandomPool, 1, '用户手动入池不得被播种重置');
    db.prepare(`UPDATE video_prompt_templates SET inRandomPool = 0 WHERE id = 'slow-push-in'`).run();
    seedMotionTemplates();
    assert.equal(readAll().find((t) => t.id === 'slow-push-in')!.inRandomPool, 0, '用户手动退池不得被播种重置');

    // ── 用户自建 / 用户接管的模板永远不许被播种动到 ─────────────────
    db.prepare(`
      INSERT INTO video_prompt_templates (id, name, description, prompt, category, isBuiltin)
      VALUES ('my-push', ?, ?, ?, 'camera_motion', 0)
    `).run('我的推镜头', '同事自己调的', '以当前图片为首帧，按我们家的节奏推进。不要添加文字。');
    db.prepare(`UPDATE video_prompt_templates SET isBuiltin = 0, prompt = ? WHERE id = 'handheld-drift'`)
      .run('以当前图片为首帧，这是同事改过的手持描述。不要添加文字。');

    seedMotionTemplates();
    assert.equal(
      readAll().find((t) => t.id === 'handheld-drift')!.prompt,
      '以当前图片为首帧，这是同事改过的手持描述。不要添加文字。',
      '用户接管（isBuiltin = 0）的模板不得被播种覆盖',
    );
    assert.ok(readAll().some((t) => t.id === 'my-push'), '用户自建模板不得被播种删除');
  } finally {
    closeDatabase?.();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log('video motion template seed tests passed');
}
