import { redirect } from 'next/navigation';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import ChangePasswordPanel from '@/components/team/ChangePasswordPanel';

export default async function TeamAccountPage() {
  const principal = await requireTeamPageAccess();
  if (!principal) redirect('/');
  return <ChangePasswordPanel displayName={principal.displayName} />;
}
