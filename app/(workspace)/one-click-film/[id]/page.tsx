import { Suspense } from 'react';
import { OneClickFilmWorkspace } from '@/components/one-click-film/OneClickFilmWorkspace';

export const dynamic = 'force-dynamic';

export default async function OneClickFilmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<div className="p-6 text-ink-secondary">加载中…</div>}>
    <OneClickFilmWorkspace projectId={id} />
  </Suspense>;
}
