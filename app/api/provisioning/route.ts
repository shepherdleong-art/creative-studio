import { NextResponse } from 'next/server';
import { MAX_PROVISIONING_FILE_BYTES, decryptProvisioningPayload } from '@/lib/provisioning/crypto';
import { applyProvisioningPayload, readProvisioningStatus } from '@/lib/provisioning/service';
import { getVideoProviderGatewayReadiness } from '@/lib/video-provider-schema-runtime';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(readProvisioningStatus());
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_PROVISIONING_FILE_BYTES + 128 * 1024) {
      return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
    }
    const form = await request.formData();
    const fileValue = form.get('file');
    const passwordValue = form.get('password');
    if (!(fileValue instanceof File) || typeof passwordValue !== 'string' || !passwordValue) {
      return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
    }
    if (fileValue.size <= 0 || fileValue.size > MAX_PROVISIONING_FILE_BYTES) {
      return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
    }
    const bytes = Buffer.from(await fileValue.arrayBuffer());
    if (bytes.byteLength > MAX_PROVISIONING_FILE_BYTES) {
      return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
    }
    // Authenticate the package before touching any local state.
    const payload = decryptProvisioningPayload(bytes, passwordValue);
    // The import upserts openai-video providers; on databases created by older
    // builds the video_providers CHECK constraint still rejects that type, so
    // run the safe (backup + cross-process lock + audit) schema upgrade first.
    const readiness = await getVideoProviderGatewayReadiness();
    if (!readiness.available) {
      return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
    }
    const status = applyProvisioningPayload(payload);
    return NextResponse.json({ ...status, message: '统一配置已导入，公司网关需启动，可能需要重启' });
  } catch {
    // Authentication, schema and persistence failures deliberately share one
    // response; never expose a key, YAML, or provider field in the API.
    return NextResponse.json({ error: '统一配置导入失败' }, { status: 400 });
  }
}
