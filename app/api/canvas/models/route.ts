import { NextResponse } from 'next/server';
import { listCanvasCapabilities } from '@/lib/creative-canvas/capabilities';
import { readCanvasRuntimeConfig } from '@/lib/creative-canvas/config';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 脱敏的可用模型与能力；不返回密钥、私密配置或完整鉴权 URL。 */
export async function GET() {
  try {
    await assertCanvasApiReady();
    const config = readCanvasRuntimeConfig();
    return NextResponse.json({
      models: listCanvasCapabilities().map((capability) => ({
        key: capability.key,
        displayName: capability.displayName,
        mediaKind: capability.mediaKind,
        modes: capability.modes,
        inputs: capability.inputs,
        parameters: capability.parameters,
        cancellation: capability.cancellation,
        evidence: capability.evidence,
        evidenceNote: capability.evidenceNote,
        providerKind: capability.providerKind,
      })),
      executor: config.executor,
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
