import { redirect } from 'next/navigation';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import TeamDownloadsPanel from '@/components/team/TeamDownloadsPanel';

export default async function TeamDownloadsPage() {
  if (!await requireTeamPageAccess()) redirect('/');
  return <TeamDownloadsPanel />;
}
