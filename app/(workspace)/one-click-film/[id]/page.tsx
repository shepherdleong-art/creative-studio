import { Suspense } from 'react';
import { OneClickFilmWorkspace } from '@/components/one-click-film/OneClickFilmWorkspace';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export const dynamic = 'force-dynamic';

export default async function OneClickFilmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTeamPageAccess({ projectId: id });
  return <Suspense fallback={<div className="p-6 text-ink-secondary">加载中…</div>}>
    <OneClickFilmWorkspace projectId={id} />
  </Suspense>;
}
