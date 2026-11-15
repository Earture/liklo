'use strict';
/**
 * Self-test for job deletion (no network, no ASR):
 *   node scripts/test-delete.js
 *
 * Creates two throwaway jobs with their own fake artifacts, deletes one without
 * purge and one with purge, and checks which files survive.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const pipeline = require('../src/pipeline');

function setup(bvid) {
  const audio = path.join(config.DOWNLOAD_DIR, `_deltest_${bvid}.m4a`);
  fs.writeFileSync(audio, 'fake audio');
  const segs = [`_deltest_${bvid}.seg01.m4a`, `_deltest_${bvid}.seg02.m4a`, `_deltest_${bvid}.concat.txt`].map((f) => path.join(config.DOWNLOAD_DIR, f));
  segs.forEach((p) => fs.writeFileSync(p, 'fake segment'));
  const cacheDir = path.join(config.DATA_DIR, 'asr-cache', bvid);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, 'seg01_300s.json');
  fs.writeFileSync(cached, '[]');
  const transcript = path.join(config.DATA_DIR, `transcript-${bvid}.json`);
  fs.writeFileSync(transcript, '{"segments":[]}');
  return { audio, segs, cacheDir, cached, transcript };
}

function status(files) {
  return files.map((f) => (fs.existsSync(f) ? 'exists' : 'gone')).join(' ');
}

function makeJob(bvid, f) {
  const job = db.insertJob({ bvid, url: 'https://www.bilibili.com/video/' + bvid, title: 'delete test ' + bvid });
  return db.updateJob(job.id, { audio_path: f.audio, transcript_path: f.transcript, status: 'done' });
}

function teardown(f) {
  for (const p of [f.audio, f.transcript, f.cached, ...f.segs]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(f.cacheDir)) fs.rmdirSync(f.cacheDir);
}

(async function main() {
  // 1. delete without purge: intermediates gone, audio + transcript kept for reuse
  const a = setup('BVtestdeleteA');
  const jobA = makeJob('BVtestdeleteA', a);
  const r1 = pipeline.deleteJob(jobA.id, false);
  console.log('without purge:', JSON.stringify(r1));
  console.log('  audio/seg1/seg2/concat/cache/transcript:', status([a.audio, ...a.segs, a.cached, a.transcript]));
  if (db.getJob(jobA.id)) throw new Error('row should be deleted');
  teardown(a);

  // 2. delete with purge: everything gone, including the ASR cache directory
  const b = setup('BVtestdeleteB');
  const jobB = makeJob('BVtestdeleteB', b);
  const r2 = pipeline.deleteJob(jobB.id, true);
  console.log('with purge:', JSON.stringify(r2));
  console.log('  audio/transcript/cache dir:', status([b.audio, b.transcript, b.cacheDir]));
  teardown(b);

  console.log('missing id ->', pipeline.deleteJob(99999));
  console.log('ok');
})();
