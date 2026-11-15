'use strict';
/*
 * Poll a job until it finishes, then print the result summary.
 * Usage: node scripts/wait-for-job.js <jobId> [maxMinutes]
 */
const config = require('../src/config');
const { httpGet } = require('../src/util');

const id = Number(process.argv[2] || 1);
const maxMinutes = Number(process.argv[3] || 400);

(async () => {
  const start = Date.now();
  let lastStage = '';
  while ((Date.now() - start) / 60000 < maxMinutes) {
    let job;
    try {
      const res = await httpGet(`http://127.0.0.1:${config.PORT}/api/jobs/${id}`);
      job = JSON.parse(res.text);
    } catch (e) {
      console.log(`poll failed: ${e.message}`);
    }
    if (!job) { await new Promise((r) => setTimeout(r, 30000)); continue; }
    if (job.stage && job.stage !== lastStage) {
      lastStage = job.stage;
      console.log(`[${new Date().toISOString()}] ${job.status} ${job.stage}`);
    }
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      console.log('final status:', job.status);
      if (job.error) console.log('error:', job.error);
      if (job.report) console.log(`report: ${job.report.length} chars`);
      return;
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
  console.log('giving up after', maxMinutes, 'minutes');
})();
