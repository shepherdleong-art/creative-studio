import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { filmReviewCover } from '../lib/final-edit/reassembled/review-media.ts';

const db = new Database(':memory:');
db.exec(`CREATE TABLE final_edit_film_bindings(id TEXT,managedRootRelative TEXT,manifestJson TEXT);
CREATE TABLE final_edit_film_deliveries(bindingId TEXT,version INTEGER,status TEXT,jobId TEXT);
CREATE TABLE final_edit_jobs(id TEXT,kind TEXT,status TEXT,outputJson TEXT);`);
db.prepare('INSERT INTO final_edit_film_bindings VALUES (?,?,?)').run('a','reassembled/a',JSON.stringify({initialFiles:{cover:'renders/first/cover.jpg'}}));
// importFilm records a synthetic import identity, not a render-job row.
db.exec("INSERT INTO final_edit_film_deliveries VALUES ('a',1,'published','import:a'),('a',2,'published','job2'),('a',3,'reserved','job3'),('b',1,'published',NULL)");
db.prepare('INSERT INTO final_edit_jobs VALUES (?,?,?,?)').run('job2','render','succeeded',JSON.stringify({coverRelativePath:'reassembled/a/renders/job2/cover.jpg'}));
assert.equal(filmReviewCover(db,'a',1),'reassembled/a/renders/first/cover.jpg');
assert.equal(filmReviewCover(db,'a',2),'reassembled/a/renders/job2/cover.jpg');
for (const version of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>filmReviewCover(db,'a',version),{code:'review_version_invalid'});
for (const [id,version] of [['a',3],['a',4],['b',1],['missing',1]] as const) assert.throws(()=>filmReviewCover(db,id,version),{code:'film_delivery_not_found'});
db.exec("UPDATE final_edit_jobs SET status='failed' WHERE id='job2'");
assert.throws(()=>filmReviewCover(db,'a',2),{code:'film_cover_unavailable'},'Must not fall back to a different delivery');
db.exec("UPDATE final_edit_jobs SET status='succeeded',outputJson='{}' WHERE id='job2'");
assert.throws(()=>filmReviewCover(db,'a',2),{code:'film_cover_unavailable'});
assert.equal(filmReviewCover(db,'a',1),'reassembled/a/renders/first/cover.jpg','Newer failures do not alter the original cover');
db.close(); console.log('PASS published cover identity, version isolation and unavailable-artifact rejection');
