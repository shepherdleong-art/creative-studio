import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Phase 0 contract-freeze test for `lib/final-edit/audio-first-matcher.ts`.
//
// That module does NOT exist yet — implementing it is Phase 3's job (see
// docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md §12,
// Phase 3: "实现 audio-first matcher 与 diagnostics"). This file is expected
// to fail at the `await import(...)` below with a module-not-found error
// until Phase 3 lands — that failure is the correct, intentional state of
// the repo right now. Do not "fix" this by stubbing or implementing
// lib/final-edit/audio-first-matcher.ts; the point of this file is to pin
// down the exact contract (input shape, determinism, semantic floor,
// fallback mode, beat-snapping invariants, manual locks, gaps, hook
// preference) that Phase 3 must satisfy. Rules encoded below are from plan
// §7.4 (音频优先匹配) and §13 (测试矩阵纯函数行: 匹配确定性、语义地板与
// hook 偏好、节拍吸附不变量、语义矩阵回退、gap).
//
// Deliberate non-goal (per the plan's own allowance "实现可采用最小费用流
// ……但对相同输入必须返回相同输出"): no assertion below pins the exact cost
// arithmetic. Only invariants, hard constraints, and plan-stated directional
// preferences are asserted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #1 — module export name & result envelope. The plan never
// names the function or the return envelope; §7.4.2 only says the output is
// "确定性的 TimelinePlan + MatchDiagnostics", and §7.4 stresses "求解器保持
// 纯函数". Assumed for THIS TEST FILE only, not a locked spec — Phase 3
// finalizes it:
//   matchAudioFirst(input: AudioFirstMatchInput): { plan, diagnostics }
// a single pure function. Every call site below uses `await`, so an async
// Phase 3 signature still works without edits. If Phase 3 picks a different
// export name or envelope, only the dynamic-import destructure line and the
// AudioFirstMatcherModule type need to change; every assertion reads through
// `result.plan` / `result.diagnostics`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #2 — TimelineLock shape (referenced by §7.4.2's input but
// defined nowhere in the plan). Assumed minimal shape:
//   { sentenceId, assetKey, startUs, endUs }
// where startUs/endUs pin the SOURCE-side interval inside the asset — the
// narration-side interval is already fully determined by sentenceId, so the
// source interval is the only extra information a lock can carry. Locks in
// this test are always well-formed: the interval lies inside one scene and
// endUs - startUs == the sentence's duration (audio-first 1:1).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #3 — how the semantic-fallback state reaches the solver.
// §7.4.1 requires MatchDiagnostics.semanticFallback = true on LLM failure,
// and §7.4.2 item 3 makes keyword/label similarity the substitute primary
// signal in "semanticFallback 态" — yet the §7.4.2 input interface has no
// such field. Minimal assumption: a required boolean `semanticFallback` on
// the input, set by the matching layer (§7.4.1) when it served the uniform
// fallback matrix. This test deliberately does NOT infer the state from
// matrix contents (e.g. "all 0.6"), which would be a fragile heuristic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #4 — TimelinePlan / MatchDiagnostics concrete shapes. The
// plan names only the diagnostics fields backoffSentences / snappedCuts /
// semanticFallback plus "gap/issue". Assumed minimal self-consistent shapes:
//   TimelinePlan = { segments: TimelinePlanSegment[] } — one ordered segment
//     per placed sentence, ordered by narration startUs;
//   TimelinePlanSegment = { sentenceId, assetKey, startUs, endUs,
//     sourceStartUs, sourceEndUs } — narration-side interval plus source-side
//     interval; audio-first invariants: source length == narration length,
//     and the source interval lies inside one scene of the referenced asset.
//   MatchDiagnostics = { semanticFallback, backoffSentences, snappedCuts,
//     gaps, issues } — snappedCuts/gaps/issues entries are treated as opaque
//     here; only their presence/absence is asserted.
// backoffSentences is assumed to hold sentence ids (strings), consistent
// with TimelineLock.sentenceId referencing sentences by id.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #5 — semanticScores / hookScores column order. §7.4.1 says
// the matrix is "句段 × 候选场景" (m = scenes, not assets) but never fixes
// the scene ordering. Assumed: scenes flattened in encounter order — asset
// order as given in `assets`, then scene order within each asset. Every
// scenario whose flattened order is not self-evident states it in a comment.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #6 — source-window placement inside a scene (plan silent).
// §7.4.3 beat snapping is only feasible when the chosen source window leaves
// headroom on the side the cut moves toward; a window hard against the scene
// edge can never snap in that direction. The positive-snap scenario (#4)
// therefore uses scenes far longer than the segments (6s scenes vs 2s/3s
// segments, Δ = 0.1s), so the snap is feasible under any reasonable window
// placement (start-aligned, centered, …). An implementation that always
// end-aligns windows would make every positive-Δ snap infeasible — i.e. the
// §7.4.3 feature would be dead code — so asserting the snap here is taken to
// be fair. The boundary-reject scenario (#5) instead pins the window to the
// full scene (scene length == sentence duration), which makes rejection
// unconditional under ANY placement.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JUDGMENT CALL #7 — snappedCuts records only SUCCESSFUL snaps. §7.4.3:
// "吸附结果记入 MatchDiagnostics.snappedCuts；beatPoints 为空时跳过". So:
// a snap that happened => >= 1 entry; beats skipped (out of tolerance, or
// would violate boundaries/min-length) and empty beatPoints => empty array.
// Entry shape is left to Phase 3. The "最短段长" constant is intentionally
// NOT pinned to a number (the execution plan defines none; the migration
// spec §5.9 parameter table lists min_segment_duration = 0.2s): the only
// post-snap lengths in this file are 2.1s / 2.9s (scenario 4), an order of
// magnitude above 0.2s, so the assertions hold regardless of its exact value.
// ---------------------------------------------------------------------------

// --- Contract types (local to this test file) -------------------------------
// AudioFirstMatchInput mirrors plan §7.4.2 field-for-field; the only addition
// is `semanticFallback` (JUDGMENT CALL #3). TimelineLock / TimelinePlan /
// MatchDiagnostics are assumed shapes (JUDGMENT CALLs #2/#4).

interface AudioFirstSentence {
  id: string;
  text: string;
  startUs: number;
  endUs: number;
  keywords: string[];
}

interface AudioFirstScene {
  startUs: number;
  endUs: number;
  labels: string[];
  quality: number;
}

interface AudioFirstAsset {
  assetKey: string;
  shotId?: string;
  durationUs: number;
  scenes: AudioFirstScene[];
  source: 'module4' | 'external';
}

interface TimelineLock {
  sentenceId: string;
  assetKey: string;
  /** Source-side interval inside the asset (JUDGMENT CALL #2). */
  startUs: number;
  endUs: number;
}

interface AudioFirstMatchInput {
  sentences: AudioFirstSentence[];
  assets: AudioFirstAsset[];
  semanticScores: number[][];
  hookScores: number[];
  beatPoints: number[];
  manualLocks: TimelineLock[];
  maxReuse: number;
  semanticFallback: boolean; // JUDGMENT CALL #3 — not in §7.4.2's letter
}

interface TimelinePlanSegment {
  sentenceId: string;
  assetKey: string;
  /** Narration-side (output timeline) interval. */
  startUs: number;
  endUs: number;
  /** Source-side interval inside the referenced asset. */
  sourceStartUs: number;
  sourceEndUs: number;
}

interface TimelinePlan {
  segments: TimelinePlanSegment[];
}

interface MatchDiagnostics {
  semanticFallback: boolean;
  backoffSentences: string[];
  snappedCuts: unknown[];
  gaps: unknown[];
  issues: unknown[];
}

interface AudioFirstMatchResult {
  plan: TimelinePlan;
  diagnostics: MatchDiagnostics;
}

type AudioFirstMatcherModule = {
  matchAudioFirst(input: AudioFirstMatchInput): AudioFirstMatchResult;
};

// The module under test does not exist yet. This dynamic import is expected
// to reject with ERR_MODULE_NOT_FOUND — see the header comment above. Routing
// through `unknown` keeps this test file's own type-soundness independent of
// exactly what Phase 3 eventually exports.
const { matchAudioFirst } = (await import('../lib/final-edit/audio-first-matcher.ts')) as unknown as AudioFirstMatcherModule;

// --- Builders ---------------------------------------------------------------

function sentence(id: string, startUs: number, endUs: number, keywords: string[] = [], text?: string): AudioFirstSentence {
  return { id, text: text ?? `句段 ${id}`, startUs, endUs, keywords };
}

function scene(startUs: number, endUs: number, labels: string[] = [], quality = 0.9): AudioFirstScene {
  return { startUs, endUs, labels, quality };
}

function asset(
  assetKey: string,
  scenes: AudioFirstScene[],
  opts: { shotId?: string; source?: 'module4' | 'external' } = {},
): AudioFirstAsset {
  return {
    assetKey,
    durationUs: Math.max(...scenes.map((sc) => sc.endUs)),
    scenes,
    source: opts.source ?? 'module4',
    ...(opts.shotId ? { shotId: opts.shotId } : {}),
  };
}

// --- Shared invariant helpers ------------------------------------------------

function segmentFor(plan: TimelinePlan, sentenceId: string): TimelinePlanSegment {
  const seg = plan.segments.find((s) => s.sentenceId === sentenceId);
  assert.ok(seg, `plan 中应存在句段 ${sentenceId} 的片段`);
  return seg;
}

function assertSegmentReferencesInputAsset(input: AudioFirstMatchInput, seg: TimelinePlanSegment): AudioFirstAsset {
  const found = input.assets.find((a) => a.assetKey === seg.assetKey);
  assert.ok(found, `plan 引用了输入中不存在的 assetKey: ${seg.assetKey}（不得凭空捏造素材）`);
  return found;
}

function assertSourceInsideScene(assetDef: AudioFirstAsset, seg: TimelinePlanSegment) {
  const inside = assetDef.scenes.some((sc) => seg.sourceStartUs >= sc.startUs && seg.sourceEndUs <= sc.endUs);
  assert.ok(
    inside,
    `${seg.assetKey} 的源区间 [${seg.sourceStartUs}, ${seg.sourceEndUs}] 必须落在其某个场景边界内`,
  );
  assert.ok(seg.sourceEndUs <= assetDef.durationUs, `${seg.assetKey} 的源区间不得超出素材总时长`);
}

function assertAudioFirstDurationParity(seg: TimelinePlanSegment) {
  assert.equal(
    seg.sourceEndUs - seg.sourceStartUs,
    seg.endUs - seg.startUs,
    `audio-first：句段 ${seg.sentenceId} 的源侧时长必须等于口播侧时长`,
  );
}

// ---------------------------------------------------------------------------
// 1. Input shape (§7.4.2 verbatim) + determinism + solver purity + semantic
//    floor, case (a): an above-floor candidate exists, so below-floor
//    candidates must NOT be picked — even when a below-floor candidate has
//    the maximal hook score (item 6: "集合外自动回退").
// ---------------------------------------------------------------------------
// Flattened scene order (JUDGMENT CALL #5): [asset-a#0, asset-a#1, asset-b#0].
//
// Hand derivation — floor formula §7.4.2 item 1: max(0.3, 红线0.35, 该句最佳分
// × 0.85). Note the 0.3 term is vacuous since 0.3 < 0.35 always, so the floor
// is max(0.35, best×0.85):
//   s1 row [0.9, 0.75, 0.2] -> floor = max(0.35, 0.9×0.85 = 0.765) = 0.765.
//     Above-floor set = {asset-a#0 (0.9)} only; 0.75 < 0.765 excludes a#1.
//     a#1 carries hook 1.0 vs a#0's 0.0 — with hook weight 0.2 (item 6) a#1's
//     hook-boosted score (0.95) would beat a#0 (0.90) IF hook could pull
//     below-floor candidates into the acceptable set. Item 6's "集合外自动回
//     退" forbids that, so s1 MUST land on asset-a scene [0, 4_000_000]. This
//     also pins the floor's ×0.85 factor: an implementation using floor =
//     0.35 only would treat a#1 as acceptable and let the hook tip it over.
//   s2 row [0.3, 0.95, 0.1] -> floor = max(0.35, 0.95×0.85 = 0.8075) = 0.8075.
//     Above-floor set = {asset-a#1 (0.95)}; s2 MUST land on asset-a scene
//     [4_000_000, 8_000_000] despite the per-asset reuse penalty (item 5),
//     because every alternative is below floor.
const input1: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000, ['开场']), sentence('s2', 2_000_000, 5_000_000, ['产品'])],
  assets: [
    asset('asset-a', [scene(0, 4_000_000, ['开场']), scene(4_000_000, 8_000_000, ['产品'])]),
    asset('asset-b', [scene(0, 6_000_000, ['风景'], 0.8)], { source: 'external' }),
  ],
  semanticScores: [
    [0.9, 0.75, 0.2],
    [0.3, 0.95, 0.1],
  ],
  hookScores: [0.0, 1.0, 1.0],
  beatPoints: [],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};

const frozenInput1 = structuredClone(input1);
const result1 = await matchAudioFirst(input1);
const result1Again = await matchAudioFirst(input1);

// 1a. determinism (§7.4.2: "对相同输入必须返回相同输出"; §12 Phase 3 门禁:
// "相同输入产生相同时间轴")
assert.deepEqual(result1Again, result1, '同一输入调用两次必须返回完全相同的结果（确定性）');
// 1b. solver purity (§7.4: "求解器保持纯函数") — the input must not be mutated.
assert.deepEqual(input1, frozenInput1, '求解器不得修改输入对象（纯函数）');

const plan1 = result1.plan;
const diag1 = result1.diagnostics;
assert.equal(plan1.segments.length, 2, '每句一段：两个句段应各得一个片段');

const seg1s1 = plan1.segments[0];
const seg1s2 = plan1.segments[1];
assert.equal(seg1s1.sentenceId, 's1');
assert.equal(seg1s2.sentenceId, 's2');

// No beats -> narration-side placement follows the sentences exactly (audio-first).
assert.equal(seg1s1.startUs, 0);
assert.equal(seg1s1.endUs, 2_000_000);
assert.equal(seg1s2.startUs, 2_000_000);
assert.equal(seg1s2.endUs, 5_000_000);

// Floor case (a): winners come from the above-floor sets derived above.
assert.equal(seg1s1.assetKey, 'asset-a', 's1 必须选语义地板之上的 asset-a#0（0.9），而非地板之下的 0.75/0.2 候选');
assert.equal(seg1s2.assetKey, 'asset-a', 's2 必须选语义地板之上的 asset-a#1（0.95）');
assert.ok(
  seg1s1.sourceStartUs >= 0 && seg1s1.sourceEndUs <= 4_000_000,
  's1 源区间必须落在 asset-a 场景 [0, 4s] 内（即选中了场景 a#0）',
);
assert.ok(
  seg1s2.sourceStartUs >= 4_000_000 && seg1s2.sourceEndUs <= 8_000_000,
  's2 源区间必须落在 asset-a 场景 [4s, 8s] 内（即选中了场景 a#1）',
);
for (const seg of plan1.segments) {
  assertSegmentReferencesInputAsset(input1, seg);
  assertAudioFirstDurationParity(seg);
}

// Contiguity + Σ invariant with no snapping: full coverage of the narration.
assert.equal(
  plan1.segments.reduce((sum, seg) => sum + (seg.endUs - seg.startUs), 0),
  5_000_000,
  '无节拍吸附时各段口播侧时长之和必须等于句段总时长（Σ 不变量）',
);

assert.equal(diag1.semanticFallback, false, '未降级时 semanticFallback 必须为 false');
assert.deepEqual(diag1.backoffSentences, [], '两句都有地板之上候选，不得出现兜底句');
assert.deepEqual(diag1.snappedCuts, [], 'beatPoints 为空数组时必须跳过吸附（snappedCuts 为空）');

// ---------------------------------------------------------------------------
// 2. Semantic floor, case (b): only below-floor candidates exist -> the
//    solver must still place the sentence (兜底) and record it in
//    MatchDiagnostics.backoffSentences (§7.4.2 item 1: "仅无可选时兜底使用并
//    记入 backoffSentences").
// Derivation: single candidate, score 0.2 -> floor = max(0.35, 0.2×0.85 =
// 0.17) = 0.35; 0.2 < 0.35 -> below floor; no alternative exists.
// ---------------------------------------------------------------------------
const input2: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000, ['产品'])],
  assets: [asset('asset-only', [scene(0, 5_000_000, ['产品'])])],
  semanticScores: [[0.2]],
  hookScores: [0.0],
  beatPoints: [],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};
const result2 = await matchAudioFirst(input2); // must not throw — 流程不中断
assert.equal(result2.plan.segments.length, 1, '地板之下也应兜底产出片段，流程不中断');
const seg2 = result2.plan.segments[0];
assert.equal(seg2.assetKey, 'asset-only', '无可选时必须兜底使用唯一候选');
assert.equal(seg2.startUs, 0);
assert.equal(seg2.endUs, 2_000_000);
assertSegmentReferencesInputAsset(input2, seg2);
assertAudioFirstDurationParity(seg2);
assert.ok(result2.diagnostics.backoffSentences.includes('s1'), '低于语义地板的兜底句必须记入 backoffSentences');
assert.equal(result2.diagnostics.semanticFallback, false);

// ---------------------------------------------------------------------------
// 3. LLM-failure fallback mode (§7.4.1 + §7.4.2 item 3): uniform 0.6 matrix
//    + zero hooks + semanticFallback=true. The plan must still be produced
//    (流程不中断), diagnostics must echo semanticFallback=true, and with the
//    semantic signal flat, keyword/label similarity becomes the deciding
//    signal ("semanticFallback 态下的替补主信号").
// Flattened scene order (JUDGMENT CALL #5): [asset-x#0, asset-m#0, asset-z#0].
// Derivation: each row's floor = max(0.35, 0.6×0.85 = 0.51) = 0.51; every
// candidate at 0.6 is above floor -> no backoff; hooks all zero -> no hook
// preference; assets carry no shotId -> no shotId prior (item 2). All three
// assets are identical on every remaining axis (length, quality, label
// count, source). s1's keyword '开箱' overlaps ONLY asset-m — the MIDDLE
// asset in the flattened order — so no positional tie-break can pass
// spuriously: "first wins" gives s1 -> asset-x (wrong), "last wins" gives
// s1 -> asset-z (wrong), and a reuse-penalty-driven freshness preference
// cannot reach the middle either (s1 is placed first, when every candidate
// is still fresh). s2's keyword '夜景' overlaps only asset-x. Only the
// keyword signal produces the correct s1 -> asset-m, s2 -> asset-x.
// ---------------------------------------------------------------------------
const input3: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000, ['开箱'], '开箱体验'), sentence('s2', 2_000_000, 4_000_000, ['夜景'], '夜景实拍')],
  assets: [
    asset('asset-x', [scene(0, 5_000_000, ['夜景', '城市'])]),
    asset('asset-m', [scene(0, 5_000_000, ['开箱', '桌面'])]),
    asset('asset-z', [scene(0, 5_000_000, ['棚拍', '特写'])]),
  ],
  semanticScores: [
    [0.6, 0.6, 0.6],
    [0.6, 0.6, 0.6],
  ],
  hookScores: [0.0, 0.0, 0.0],
  beatPoints: [],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: true,
};
const result3 = await matchAudioFirst(input3);
assert.equal(result3.diagnostics.semanticFallback, true, '降级输入必须原样反映到 MatchDiagnostics.semanticFallback');
assert.equal(result3.plan.segments.length, 2, '降级态下流程不中断，仍应产出完整 plan');
assert.equal(
  segmentFor(result3.plan, 's1').assetKey,
  'asset-m',
  'semanticFallback 态下关键词重叠必须成为决定性信号（s1↔asset-m：开箱）',
);
assert.equal(
  segmentFor(result3.plan, 's2').assetKey,
  'asset-x',
  'semanticFallback 态下关键词重叠必须成为决定性信号（s2↔asset-x：夜景）',
);
assert.deepEqual(result3.diagnostics.backoffSentences, [], '均匀矩阵 0.6 高于地板 0.51，不得出现兜底句');
for (const seg of result3.plan.segments) {
  assertSegmentReferencesInputAsset(input3, seg);
  assertAudioFirstDurationParity(seg);
}

// ---------------------------------------------------------------------------
// 4. Beat snapping — positive case (§7.4.3). One breath point 0.1s after the
//    shared cut; |Δ| = 100_000us <= 200_000us tolerance; scenes (6s) are far
//    longer than the segments (2s/3s), so the snap is feasible under any
//    reasonable window placement (JUDGMENT CALL #6) and must happen.
// Derivation: floors = max(0.35, 0.765) per row; s1 -> asset-a (0.9 above
// floor, asset-b 0.2 below), s2 -> asset-b. Pre-snap cut at 2_000_000; beat
// at 2_100_000 -> Δ = +100_000: s1's shared end moves to 2_100_000 (duration
// 2.0s -> 2.1s), s2's duration shrinks 3.0s -> 2.9s (post-snap minimum 2.1s,
// an order of magnitude above the 0.2s 最短段长 — JUDGMENT CALL #7); Σ stays
// 5_000_000; the cut lands exactly on the beat ("吸附"); snappedCuts gains
// an entry.
// ---------------------------------------------------------------------------
const input4: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000), sentence('s2', 2_000_000, 5_000_000)],
  assets: [asset('asset-a', [scene(0, 6_000_000, ['甲'])]), asset('asset-b', [scene(0, 6_000_000, ['乙'])])],
  semanticScores: [
    [0.9, 0.2],
    [0.2, 0.9],
  ],
  hookScores: [0.0, 0.0],
  beatPoints: [2_100_000],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};
const result4 = await matchAudioFirst(input4);
const result4Again = await matchAudioFirst(input4);
assert.deepEqual(result4Again, result4, '含节拍吸附的求解同样必须满足确定性');
assert.equal(result4.plan.segments.length, 2);

const seg4s1 = segmentFor(result4.plan, 's1');
const seg4s2 = segmentFor(result4.plan, 's2');
assert.equal(seg4s1.assetKey, 'asset-a');
assert.equal(seg4s2.assetKey, 'asset-b');

// The shared cut lands exactly on the beat; its offset from the original cut
// (2_000_000) is 100_000us <= 200_000us.
assert.equal(seg4s1.endUs, 2_100_000, '吸附后共享切点必须落在气口上');
assert.equal(seg4s2.startUs, 2_100_000, '吸附后下一段必须从上一切点（气口）开始');
assert.ok(Math.abs(seg4s1.endUs - 2_000_000) <= 200_000, '切点偏移不得超过 0.2s');
// Outer boundaries never move.
assert.equal(seg4s1.startUs, 0);
assert.equal(seg4s2.endUs, 5_000_000);
// Equal-and-opposite duration changes (+Δ / −Δ).
assert.equal(seg4s1.endUs - seg4s1.startUs, 2_000_000 + 100_000, '前一段时长必须 +Δ');
assert.equal(seg4s2.endUs - seg4s2.startUs, 3_000_000 - 100_000, '后一段时长必须 −Δ（等量互补）');
// Σ invariant: total duration unchanged by snapping.
assert.equal(
  seg4s1.endUs - seg4s1.startUs + (seg4s2.endUs - seg4s2.startUs),
  5_000_000,
  '吸附后 Σ 各段时长不变',
);
// The source side mirrors the same ±Δ and stays inside the scenes.
for (const seg of result4.plan.segments) {
  assertSegmentReferencesInputAsset(input4, seg);
  assertAudioFirstDurationParity(seg);
}
assertSourceInsideScene(input4.assets[0], seg4s1);
assertSourceInsideScene(input4.assets[1], seg4s2);
assert.ok(result4.diagnostics.snappedCuts.length >= 1, '发生的吸附必须记入 MatchDiagnostics.snappedCuts');

// ---------------------------------------------------------------------------
// 5. Beat snapping — boundary rejection (§7.4.3: snap only when "仍满足各自
//    素材边界与最短段长"). s1's scene is exactly as long as the sentence, so
//    its source window is forced to the full scene under ANY window
//    placement; growing it by Δ = +100_000us would cross the scene end (and
//    the asset duration) -> the snap must NOT happen. The cut stays at
//    2_000_000; snappedCuts stays empty (JUDGMENT CALL #7).
// ---------------------------------------------------------------------------
const input5: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000), sentence('s2', 2_000_000, 5_000_000)],
  assets: [asset('asset-tight', [scene(0, 2_000_000, ['甲'])]), asset('asset-b', [scene(0, 6_000_000, ['乙'])])],
  semanticScores: [
    [0.9, 0.2],
    [0.2, 0.9],
  ],
  hookScores: [0.0, 0.0],
  beatPoints: [2_100_000],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};
const result5 = await matchAudioFirst(input5);
assert.equal(result5.plan.segments.length, 2);
const seg5s1 = segmentFor(result5.plan, 's1');
const seg5s2 = segmentFor(result5.plan, 's2');
assert.equal(seg5s1.assetKey, 'asset-tight');
assert.equal(seg5s1.endUs, 2_000_000, '吸附会越过场景边界时必须放弃吸附，切点保持原位');
assert.equal(seg5s2.startUs, 2_000_000);
assert.deepEqual(result5.diagnostics.snappedCuts, [], '未发生的吸附不得记入 snappedCuts');

// ---------------------------------------------------------------------------
// 6. Beat snapping — out-of-tolerance skip (§7.4.3: "偏移 ≤ 0.2s"). The only
//    breath point is 1.5s away from the only cut -> no snap. (The empty-
//    beatPoints skip is already asserted in scenario 1.)
// ---------------------------------------------------------------------------
const input6: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 2_000_000), sentence('s2', 2_000_000, 5_000_000)],
  assets: [asset('asset-a', [scene(0, 6_000_000, ['甲'])]), asset('asset-b', [scene(0, 6_000_000, ['乙'])])],
  semanticScores: [
    [0.9, 0.2],
    [0.2, 0.9],
  ],
  hookScores: [0.0, 0.0],
  beatPoints: [3_500_000],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};
const result6 = await matchAudioFirst(input6);
assert.equal(result6.plan.segments.length, 2);
const seg6s1 = segmentFor(result6.plan, 's1');
const seg6s2 = segmentFor(result6.plan, 's2');
assert.equal(seg6s1.endUs, 2_000_000, '气口距最近切点超过 0.2s 时不得吸附');
assert.equal(seg6s2.startUs, 2_000_000);
assert.deepEqual(result6.diagnostics.snappedCuts, [], '未发生的吸附不得记入 snappedCuts');

// ---------------------------------------------------------------------------
// 7. Manual locks are a hard constraint (§7.4.2 item 7). Without the lock,
//    s1 must pick asset-hi (0.95 above floor max(0.35, 0.95×0.85 = 0.8075);
//    asset-lo at 0.1 is even below the 0.35 red line). With a lock pinning
//    s1 to asset-lo's source interval [1s, 3s] (length 2s == the sentence
//    duration, inside scene [0, 6s] — well-formed per JUDGMENT CALL #2), the
//    output must honor it verbatim — assetKey, sourceStartUs, sourceEndUs —
//    despite the bottom-scored semantic signal.
// ---------------------------------------------------------------------------
function input7(manualLocks: TimelineLock[]): AudioFirstMatchInput {
  return {
    sentences: [sentence('s1', 0, 2_000_000, ['匹配']), sentence('s2', 2_000_000, 5_000_000, ['匹配'])],
    assets: [asset('asset-lo', [scene(0, 6_000_000, ['无关'])]), asset('asset-hi', [scene(0, 6_000_000, ['匹配'])])],
    semanticScores: [
      [0.1, 0.95],
      [0.1, 0.95],
    ],
    hookScores: [0.0, 0.0],
    beatPoints: [],
    manualLocks,
    maxReuse: 3,
    semanticFallback: false,
  };
}

const unlocked7 = await matchAudioFirst(input7([]));
assert.equal(segmentFor(unlocked7.plan, 's1').assetKey, 'asset-hi', '未锁定时 s1 必须选语义赢家 asset-hi（对照组）');

const locked7 = await matchAudioFirst(input7([{ sentenceId: 's1', assetKey: 'asset-lo', startUs: 1_000_000, endUs: 3_000_000 }]));
assert.equal(locked7.plan.segments.length, 2);
const seg7s1 = segmentFor(locked7.plan, 's1');
assert.equal(seg7s1.assetKey, 'asset-lo', '锁定为硬约束：必须逐字遵守 lock 的 assetKey');
assert.equal(seg7s1.sourceStartUs, 1_000_000, '锁定为硬约束：必须逐字遵守 lock 的 startUs');
assert.equal(seg7s1.sourceEndUs, 3_000_000, '锁定为硬约束：必须逐字遵守 lock 的 endUs');
assert.equal(seg7s1.startUs, 0);
assert.equal(seg7s1.endUs, 2_000_000);
assert.equal(segmentFor(locked7.plan, 's2').assetKey, 'asset-hi', 's2 不受锁定影响，仍选语义赢家 asset-hi');

// ---------------------------------------------------------------------------
// 8. Insufficient material -> explicit gap/issue, no fabricated assets
//    (§7.4.2: "素材不足产生显式 gap/issue，不得跨组取材").
// s2 needs 5s contiguous; the only scene is 4s -> s2 has no length-feasible
// candidate (hard constraint, migration spec §5.6: 分配素材 available >= 句
// 时长), so the plan cannot cover the narration. Whether Phase 3 places s2
// truncated or leaves it unplaced is deliberately NOT asserted. What is
// asserted:
//   (a) at least one explicit gap/issue entry exists;
//   (b) every referenced assetKey comes from the input (不得凭空捏造素材 —
//       "不跨组取材" at this layer);
//   (c) every placed source interval stays inside a real scene (a 5s source
//       interval claimed inside a 4s scene would be fabrication and is
//       caught here).
// ---------------------------------------------------------------------------
const input8: AudioFirstMatchInput = {
  sentences: [sentence('s1', 0, 3_000_000, ['产品']), sentence('s2', 3_000_000, 8_000_000, ['产品'])],
  assets: [asset('asset-tiny', [scene(0, 4_000_000, ['产品'])])],
  semanticScores: [[0.9], [0.9]],
  hookScores: [0.0],
  beatPoints: [],
  manualLocks: [],
  maxReuse: 3,
  semanticFallback: false,
};
const result8 = await matchAudioFirst(input8);
assert.ok(
  result8.diagnostics.gaps.length + result8.diagnostics.issues.length > 0,
  '唯一场景 4s 容纳不了 s2 的 5s 句段（无长度可行候选）时必须产生显式 gap/issue 记录',
);
for (const seg of result8.plan.segments) {
  const assetDef = assertSegmentReferencesInputAsset(input8, seg);
  assertSourceInsideScene(assetDef, seg);
}

// ---------------------------------------------------------------------------
// 9. Hook preference, direction only (§7.4.2 item 6). Opening sentence, two
//    candidates identical on EVERY axis (semantic 0.8/0.8, quality, labels,
//    length, source) except hookScores (0.1 vs 0.9); both are above the
//    floor (0.8 >= max(0.35, 0.8×0.85 = 0.68)). The plan must prefer the
//    higher hook score. No exact weighting arithmetic is pinned — with
//    everything else tied, ANY positive hook preference picks asset-hi, and
//    picking asset-lo means the preference is absent. The scenario runs with
//    BOTH asset orderings, so neither a "first wins" nor a "last wins"
//    tie-break can pass spuriously. (The complementary half of item 6 —
//    hook must NOT pull a below-floor candidate into the acceptable set,
//    "集合外自动回退" — is pinned in scenario 1, where the 0.75-scored,
//    hook-1.0 candidate loses to the 0.9-scored, hook-0.0 one.)
// ---------------------------------------------------------------------------
function input9(assets: AudioFirstAsset[]): AudioFirstMatchInput {
  return {
    sentences: [sentence('s1', 0, 2_000_000, ['开场'])],
    assets,
    // semanticScores columns follow the flattened scene order of whichever
    // asset list is passed in; the single row is [0.8, 0.8] either way, and
    // hookScores are derived here by asset position so each asset keeps its
    // own hook score across the two orderings (lo -> 0.1, hi -> 0.9).
    semanticScores: [[0.8, 0.8]],
    hookScores: assets[0].assetKey === 'asset-lo' ? [0.1, 0.9] : [0.9, 0.1],
    beatPoints: [],
    manualLocks: [],
    maxReuse: 3,
    semanticFallback: false,
  };
}

const hookAssetsLoFirst = [asset('asset-lo', [scene(0, 5_000_000, ['开场'])]), asset('asset-hi', [scene(0, 5_000_000, ['开场'])])];
const hookAssetsHiFirst = [hookAssetsLoFirst[1], hookAssetsLoFirst[0]];

const result9a = await matchAudioFirst(input9(hookAssetsLoFirst));
assert.equal(segmentFor(result9a.plan, 's1').assetKey, 'asset-hi', '语义可接受集合内开场句必须偏好高 hook 分（方向性，asset-lo 在前）');
const result9b = await matchAudioFirst(input9(hookAssetsHiFirst));
assert.equal(segmentFor(result9b.plan, 's1').assetKey, 'asset-hi', '语义可接受集合内开场句必须偏好高 hook 分（方向性，asset-hi 在前）');

console.log('final-edit audio-first-matcher contract tests passed');
