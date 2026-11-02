import { getDb } from '@/lib/db';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { requireCanvasAccess, requireProjectAccess } from '@/lib/team-service/resource-scopes';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function requireTeamPageAccess(options: { admin?: boolean; projectId?: string; canvasId?: string } = {}) {
  if (readRuntimeConfig().mode === 'local') return null;
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const principal = token ? getTeamAuthService().resolveSession(token) : null;
  if (!principal || principal.mustChangePassword) redirect('/team/login');
  if (options.admin && principal.role !== 'admin') redirect('/');
  if (options.projectId) {
    try { requireProjectAccess(getDb(), principal, options.projectId, 'read'); }
    catch { redirect('/'); }
  }
  if (options.canvasId) {
    try { requireCanvasAccess(getDb(), principal, options.canvasId, 'read'); }
    catch { redirect('/'); }
  }
  return principal;
}
