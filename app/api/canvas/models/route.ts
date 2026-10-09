import { NextResponse } from 'next/server';
import { ensureCanvasCapabilitiesRegistered } from '@/lib/creative-canvas/capabilities-bootstrap';
import { getDb } from '@/lib/db';
import { readCanvasRuntimeConfig } from '@/lib/creative-canvas/config';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 脱敏的可用模型与能力；不返回密钥、私密配置或完整鉴权 URL。 */
export async function GET() {
  try {
    await assertCanvasApiReady();
    const config = readCanvasRuntimeConfig();
    return NextResponse.json({
      models: ensureCanvasCapabilitiesRegistered(getDb()).map((capability) => ({
        key: capability.key,
        displayName: capability.displayName,
        mediaKind: capability.mediaKind,
        modes: capability.modes,
        legacyModes: capability.legacyModes,
        inputs: capability.inputs,
        parameters: capability.parameters,
        cancellation: capability.cancellation,
        evidence: capability.evidence,
        evidenceNote: capability.evidenceNote,
        providerKind: capability.providerKind,
        ...(capability.modeLabels ? { modeLabels: capability.modeLabels } : {}),
        ...(capability.modeHints ? { modeHints: capability.modeHints } : {}),
      })),
      executor: config.executor,
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
