/**
 * 规矩 h：每条成片都要满足的五条。返回人话的违规说明，空数组表示全部通过。
 * 只读排片结果，不改任何东西。
 */
import type { SchedulingFile, SchedulingSlotMaterial, TimelinePlan, VoicePlan } from './types.ts';

export interface ValidateInput {
  plan: VoicePlan;
  timeline: TimelinePlan;
  /** 给了就顺带检查画面是否落在素材文件范围内。 */
  materials?: readonly SchedulingSlotMaterial[];
}

export function validateFormulaShortFilm(input: ValidateInput): string[] {
  const { plan, timeline } = input;
  const problems: string[] = [];

  // 1. 文案每一行要么被原声覆盖，要么配音读一次；不漏，不重。
  const narrated = new Map<number, number>();
  for (const sound of timeline.sounds) {
    if (sound.kind !== 'narration') continue;
    for (const lineIndex of sound.lineIndexes) narrated.set(lineIndex, (narrated.get(lineIndex) ?? 0) + 1);
  }
  for (const line of plan.lines) {
    if (line.fate?.type === 'source') {
      if (narrated.has(line.index)) problems.push(`第 ${line.index + 1} 行已被原声覆盖，却又配了音`);
    } else if ((narrated.get(line.index) ?? 0) !== 1) {
      problems.push(`第 ${line.index + 1} 行没有配音（或配了 ${narrated.get(line.index) ?? 0} 次）`);
    }
  }

  // 2. 每段画面都在素材文件范围内；没有静帧、倒放或变速。
  const files = new Map<string, SchedulingFile>();
  for (const material of input.materials ?? []) for (const file of material.files) files.set(file.assetId, file);
  let previousEnd = 0;
  for (const clip of timeline.clips) {
    if (clip.timelineStartFrame !== previousEnd) problems.push(`画面 ${clip.id} 与上一段之间有缝隙或重叠`);
    if (clip.timelineEndFrame <= clip.timelineStartFrame) problems.push(`画面 ${clip.id} 没有长度（静帧）`);
    if (clip.sourceOutUs <= clip.sourceInUs) problems.push(`画面 ${clip.id} 的取用区间倒放或为空`);
    const file = files.get(clip.assetId);
    if (file && (clip.sourceInUs < 0 || clip.sourceOutUs > file.durationUs)) {
      problems.push(`画面 ${clip.id} 超出素材 ${file.fileName} 的范围`);
    }
    previousEnd = clip.timelineEndFrame;
  }

  // 3. 原声和配音不重叠。
  const sounds = [...timeline.sounds].sort((left, right) => left.timelineStartFrame - right.timelineStartFrame);
  for (let index = 1; index < sounds.length; index += 1) {
    if (sounds[index].timelineStartFrame < sounds[index - 1].timelineEndFrame) {
      problems.push(`${sounds[index - 1].id} 和 ${sounds[index].id} 的声音叠在一起`);
    }
  }

  // 4. 公式镜头严格按公式顺序（用不上的跳过）；补镜只插在镜头之间或片尾。
  const formulaClips = timeline.clips.filter(clip => clip.kind !== 'filler');
  const formulaItems = plan.items.filter((item): item is Extract<VoicePlan['items'][number], { kind: 'shot' | 'vo' }> =>
    (item.kind === 'shot' && !item.dropped) || item.kind === 'vo');
  if (formulaClips.length !== formulaItems.length) {
    problems.push(`公式镜头有 ${formulaItems.length} 段，画面里出现了 ${formulaClips.length} 段`);
  } else {
    formulaItems.forEach((item, index) => {
      const clip = formulaClips[index];
      if (clip.logicalCode !== item.logicalCode) problems.push(`第 ${index + 1} 段画面应为 ${item.logicalCode}，实际是 ${clip.logicalCode}`);
    });
  }

  // 5. 需要配音的文案最后一行，是成片最后一句声音。
  const lastLine = plan.lines[plan.lines.length - 1];
  if (lastLine && !lastLine.fate) {
    const lastSound = sounds[sounds.length - 1];
    if (!lastSound || lastSound.kind !== 'narration' || !lastSound.lineIndexes.includes(lastLine.index)) {
      problems.push(`需要配音的文案最后一行（第 ${lastLine.index + 1} 行）不是成片最后一句声音`);
    }
  }

  return problems;
}
