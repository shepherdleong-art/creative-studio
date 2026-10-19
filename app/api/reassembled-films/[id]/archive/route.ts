import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { archivePriorFilm } from '@/lib/final-edit/reassembled/delivery';
import { refreshFilmReview } from '@/lib/final-edit/reassembled/review';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';
import type { FilmBinding } from '@/lib/final-edit/reassembled/types';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkLocalRequest(request); const db = getDb();
    const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get((await params).id) as FilmBinding | undefined;
    if (!binding) throw new FinalEditError('film_not_found', '成片不存在', 404);
    const warning = archivePriorFilm(db, binding, binding.deliveryVersion);
    db.prepare('UPDATE final_edit_film_deliveries SET archiveWarning=? WHERE bindingId=? AND version=?').run(warning, binding.id, binding.deliveryVersion);
    const delivery = db.prepare('SELECT jobId FROM final_edit_film_deliveries WHERE bindingId=? AND version=?').get(binding.id, binding.deliveryVersion) as {jobId:string};
    const job = db.prepare('SELECT outputJson FROM final_edit_jobs WHERE id=?').get(delivery.jobId) as {outputJson:string|null} | undefined;
    if (job?.outputJson) db.prepare('UPDATE final_edit_jobs SET outputJson=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(job.outputJson), archiveWarning: warning }), delivery.jobId);
    refreshFilmReview(db, binding.id);
    return NextResponse.json({ warning });
  } catch (error) { return finalEditErrorResponse(error); }
}
