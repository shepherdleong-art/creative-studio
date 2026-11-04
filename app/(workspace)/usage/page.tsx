import UsageDashboard from '@/components/UsageDashboard';
import TeamUsagePanel from '@/components/team/TeamUsagePanel';
import { readRuntimeConfig } from '@/lib/team-service/config';

export default function UsagePage() {
  if (readRuntimeConfig().mode === 'server') return <TeamUsagePanel />;
  return <UsageDashboard />;
}
