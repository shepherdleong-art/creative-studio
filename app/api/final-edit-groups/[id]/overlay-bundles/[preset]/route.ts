import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { OUTPUT_PRESETS, type OutputPresetId } from '@/lib/final-edit/types';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { alphaBoundsWidth, overlayMeasurementLimit, textInterval } from '@/lib/final-edit/overlay-measurement';

function digest(value: string | Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string; preset: string }> }) {
  try {
    const { id, preset: rawPreset } = await params;
    if (!(rawPreset in OUTPUT_PRESETS)) return NextResponse.json({ error: 'invalid_output_preset' }, { status: 400 });
    const preset = rawPreset as OutputPresetId;
    const group = getFinalEditWorkspace().load(id);
    const body = await request.json() as { groupRevision?: number; titlePngBase64?: string; subtitlePngs?: Record<string, string>; manifest?: { width?: number; height?: number; overflow?: boolean; measurements?: { titlePrimaryWidth?: number; titleSecondaryWidth?: number; subtitleWidths?: Record<string, number> }; cues?: Array<{ id: string; startUs: number; endUs: number }> } };
    if (body.groupRevision !== group.revision) return NextResponse.json({ error: 'revision_conflict', currentRevision: group.revision }, { status: 409 });
    const expected = OUTPUT_PRESETS[preset];
    if (body.manifest?.width !== expected.width || body.manifest?.height !== expected.height) return NextResponse.json({ error: 'overlay_dimensions_invalid' }, { status: 400 });
    const measurements = body.manifest.measurements;
    const finiteWidth = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const styles = group.textStyles[preset];
    if (body.manifest.overflow !== false || !measurements || !finiteWidth(measurements.titlePrimaryWidth) || !finiteWidth(measurements.titleSecondaryWidth)
      || Number(measurements.titlePrimaryWidth) > styles.coverPrimary.boxWidthPx || Number(measurements.titleSecondaryWidth) > styles.coverSecondary.boxWidthPx) {
      return NextResponse.json({ error: 'overlay_text_overflow' }, { status: 400 });
    }
    const manifestCues = body.manifest?.cues || [];
    if (manifestCues.length !== group.subtitleCues.length || group.subtitleCues.some((cue) => !manifestCues.some((item) => item.id === cue.id && item.startUs === cue.startUs && item.endUs === cue.endUs))) return NextResponse.json({ error: 'overlay_manifest_stale' }, { status: 409 });
    if (group.subtitleCues.some((cue) => !finiteWidth(measurements.subtitleWidths?.[cue.id]) || Number(measurements.subtitleWidths?.[cue.id]) > styles.subtitle.boxWidthPx)) return NextResponse.json({ error: 'overlay_text_overflow' }, { status: 400 });
    const title = Buffer.from(String(body.titlePngBase64 || ''), 'base64');
    const subtitleBuffers = Object.fromEntries(group.subtitleCues.map((cue) => [cue.id, Buffer.from(String(body.subtitlePngs?.[cue.id] || ''), 'base64')]));
    const buffers = [title, ...Object.values(subtitleBuffers)];
    if (buffers.some((buffer) => buffer.length === 0 || buffer.length > 20 * 1024 * 1024) || buffers.reduce((sum, buffer) => sum + buffer.length, 0) > 250 * 1024 * 1024) return NextResponse.json({ error: 'overlay_size_invalid' }, { status: 413 });
    for (const buffer of buffers) {
      const metadata = await sharp(buffer).metadata();
      if (metadata.format !== 'png' || metadata.width !== expected.width || metadata.height !== expected.height) return NextResponse.json({ error: 'overlay_dimensions_invalid' }, { status: 400 });
    }
    const primaryInterval = textInterval(Number(measurements.titlePrimaryWidth), styles.coverPrimary.x * expected.width, styles.coverPrimary.align);
    const secondaryInterval = textInterval(Number(measurements.titleSecondaryWidth), styles.coverSecondary.x * expected.width, styles.coverSecondary.align);
    const expectedTitleWidth = Math.max(primaryInterval[1], secondaryInterval[1]) - Math.min(primaryInterval[0], secondaryInterval[0]);
    if (await alphaBoundsWidth(title) > overlayMeasurementLimit(expectedTitleWidth)) return NextResponse.json({ error: 'overlay_measurement_mismatch' }, { status: 400 });
    for (const [cueId, buffer] of Object.entries(subtitleBuffers)) {
      if (await alphaBoundsWidth(buffer) > overlayMeasurementLimit(Number(measurements.subtitleWidths?.[cueId]))) return NextResponse.json({ error: 'overlay_measurement_mismatch' }, { status: 400 });
    }
    const specHash = digest(JSON.stringify({ groupRevision: group.revision, preset, coverTitle: group.coverTitle, cues: group.subtitleCues, styles: group.textStyles[preset], renderer: 1 }));
    const existing = getDb().prepare(`SELECT id FROM final_edit_overlay_bundles WHERE groupId=? AND outputPreset=? AND specHash=? AND status='ready'`).get(id, preset, specHash) as { id: string } | undefined;
    if (existing) return NextResponse.json({ id: existing.id, specHash, reused: true });
    const bundleId = uuidv4();
    const relativeDir = path.join('final-edits', 'groups', id, 'overlays', preset, specHash);
    const absoluteDir = path.join(dataRoot(), 'storage', relativeDir);
    fs.mkdirSync(absoluteDir, { recursive: true });
    fs.writeFileSync(path.join(absoluteDir, 'title.png.tmp'), title); fs.renameSync(path.join(absoluteDir, 'title.png.tmp'), path.join(absoluteDir, 'title.png'));
    for (const [cueId, buffer] of Object.entries(subtitleBuffers)) { const target = path.join(absoluteDir, `subtitle-${cueId}.png`); fs.writeFileSync(`${target}.tmp`, buffer); fs.renameSync(`${target}.tmp`, target); }
    const manifest = { ...body.manifest, specHash, fonts: { primary: styles.coverPrimary.fontFamily, secondary: styles.coverSecondary.fontFamily, subtitle: styles.subtitle.fontFamily }, titleSha256: digest(title), subtitles: Object.fromEntries(Object.entries(subtitleBuffers).map(([key, value]) => [key, digest(value)])) };
    fs.writeFileSync(path.join(absoluteDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    getDb().prepare(`INSERT INTO final_edit_overlay_bundles (id, groupId, outputPreset, groupRevision, specHash, manifestJson, relativeDir, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`).run(bundleId, id, preset, group.revision, specHash, JSON.stringify(manifest), relativeDir, new Date().toISOString());
    return NextResponse.json({ id: bundleId, specHash, reused: false }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: 'overlay_bundle_invalid', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
