import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readProjectShotSetStatuses, resolveShotSetStatus } from '../lib/shot-set-status.ts';

const db = new Database(':memory:');
try {
  db.exec(`
    CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT, status TEXT, kind TEXT);
    CREATE TABLE shots (id TEXT PRIMARY KEY, shotSetId TEXT, latestJobId TEXT, latestGeneratedImageId TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO shot_sets VALUES ('set', 'p1', 'generating', 'storyboard'), ('empty', 'p1', 'draft', 'storyboard'), ('other', 'p2', 'generating', 'storyboard');
    INSERT INTO jobs VALUES ('j1', 'succeeded'), ('j2', 'running'), ('old-failure', 'failed');
    INSERT INTO shots VALUES ('s1', 'set', 'j1', 'image1'), ('s2', 'set', 'j2', 'old-image2');
  `);
  const status = () => readProjectShotSetStatuses(db, 'p1').get('set');
  assert.equal(status(), 'generating', '保留旧结果的重做仍是生成中');
  for (const state of ['pending', 'retrying', 'needs_check']) {
    db.prepare('UPDATE jobs SET status=? WHERE id=?').run(state, 'j2');
    assert.equal(status(), 'generating', state);
  }
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id='j2'").run();
  assert.equal(status(), 'completed', '最后一张完成后，历史 generating 记录也应显示已完成');
  assert.equal(readProjectShotSetStatuses(db, 'p1').get('empty'), 'draft');
  assert.equal(readProjectShotSetStatuses(db, 'p1').has('other'), false, '不混入其他项目');
  for (const state of ['failed', 'canceled']) {
    db.prepare('UPDATE jobs SET status=? WHERE id=?').run(state, 'j2');
    assert.equal(status(), 'reviewing', '失败或取消不能因有旧图而算作完成');
  }
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id='j2'").run();
  db.prepare("UPDATE shots SET latestGeneratedImageId=NULL WHERE id='s2'").run();
  assert.equal(status(), 'reviewing', '有成功状态但缺少产物仍需检查');
  const done = [{ latestJobId: 'j1', jobStatus: 'succeeded', latestGeneratedImageId: 'image1' }];
  for (const state of ['approved', 'video_ready', 'reviewing']) {
    assert.equal(resolveShotSetStatus({ status: state }, done), state, '人工审核状态保留');
  }
  assert.equal(resolveShotSetStatus({ status: 'approved', kind: 'free' }, [{ jobStatus: 'running' }]), 'approved');
  assert.equal(resolveShotSetStatus({ status: 'generating' }, []), 'draft');
  console.log('shot-set-status tests passed');
} finally {
  db.close();
}
