import { redirect } from 'next/navigation';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import TeamLoginForm from '@/components/team/TeamLoginForm';

export default async function TeamAccountPage() {
  const principal = await requireTeamPageAccess();
  if (!principal) redirect('/');
  return <div className="mx-auto max-w-md"><TeamLoginForm changePassword /></div>;
}
