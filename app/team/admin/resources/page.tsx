import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import TeamPublicResourcesPanel from '@/components/team/TeamPublicResourcesPanel';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';

export const dynamic = 'force-dynamic';

export default async function TeamPublicResourcesPage() {
  if (readRuntimeConfig().mode !== 'server') redirect('/');
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const principal = token ? getTeamAuthService().resolveSession(token) : null;
  if (!principal || principal.mustChangePassword) redirect('/team/login');
  if (principal.role !== 'admin') redirect('/');
  return <TeamPublicResourcesPanel />;
}
