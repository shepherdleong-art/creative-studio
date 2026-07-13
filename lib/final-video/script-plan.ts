// lib/final-video/script-plan.ts
/**
 * 把 script_drafts.outputJson 读成成片引擎要消费的「计划」。
 *
 * v2（脚本看图后产出）：segments[] 就是计划本身——数组顺序即成片画面顺序。
 * 旧格式（脚本瞎写时代）：shots[] 按 indexNum 顺序 1:1 读成 segments，imageAssetId 置 null
 *   表示"不知道当时看的是哪张图"，故不做过期检测。行为与改造前一致。
 */

export interface ScriptPlanSegment {
  shotId: string;
  /** 脚本写作时看的那张图。旧格式为 null。 */
  imageAssetId: string | null;
  narration: string;
  subtitle: string;
  rationale: string;
}

export interface ScriptPlan {
  segments: ScriptPlanSegment[];
  /** 未被使用的分镜 = 备用池，供 build-arrangement 替补缺失素材。 */
  droppedShotIds: string[];
  /** true 表示这是改造前的旧脚本，界面应提示"建议重新生成以获得看图文案"。 */
  legacy: boolean;
}

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function invalidInputError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

export function parseScriptPlan(outputJson: string): ScriptPlan {
  // outputJson 本身是坏 JSON 时让 JSON.parse 抛出（路由回落 500）——绝不当作"空脚本"吞掉。
  const parsed = JSON.parse(outputJson) as Raw;

  if (parsed.version === 2 && Array.isArray(parsed.segments)) {
    const segments: ScriptPlanSegment[] = [];
    for (const item of parsed.segments) {
      const entry = (item && typeof item === 'object' ? item : {}) as Raw;
      const shotId = str(entry.shotId);
      const narration = str(entry.narration);
      if (!shotId || !narration) continue;
      segments.push({
        shotId,
        imageAssetId: str(entry.imageAssetId) || null,
        narration,
        subtitle: str(entry.subtitle) || narration,
        rationale: str(entry.rationale),
      });
    }
    if (segments.length === 0) throw invalidInputError('脚本内容为空，无法生成口播');

    const dropped = Array.isArray(parsed.droppedShots) ? parsed.droppedShots : [];
    const droppedShotIds = dropped
      .map((item) => str(((item && typeof item === 'object' ? item : {}) as Raw).shotId))
      .filter(Boolean);

    return { segments, droppedShotIds, legacy: false };
  }

  // ── 旧格式形状适配 ──
  const shots = Array.isArray(parsed.shots) ? parsed.shots : [];
  const segments: ScriptPlanSegment[] = [];
  for (const item of shots) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    const narration = str(entry.voiceover);
    if (!shotId || !narration) continue;
    segments.push({
      shotId,
      imageAssetId: null,
      narration,
      subtitle: str(entry.subtitle) || narration,
      rationale: str(entry.visualIntent),
    });
  }
  if (segments.length === 0) throw invalidInputError('脚本内容为空，无法生成口播');

  return { segments, droppedShotIds: [], legacy: true };
}
