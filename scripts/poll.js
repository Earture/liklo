'use strict';
// Polls a job until it finishes and prints a short summary.
// usage: node scripts/poll.js <jobId>
const id = Number(process.argv[2] || 1);
const maxMinutes = Number(process.argv[3] || 60);

(async () => {
  let last = '';
  const deadline = Date.now() + maxMinutes * 60000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://localhost:3200/api/jobs/${id}`);
    const job = await res.json();
    const line = `${new Date().toISOString()} status=${job.status} stage=${job.stage || ''}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (job.status === 'done' || job.status === 'error') {
      console.log('transcript chars:', (job.transcript || '').length);
      console.log('report chars:', (job.report || '').length);
      if (job.error) console.log('error:', job.error);
      if (job.report) {
        const fs = require('fs');
        const path = require('path');
        const outDir = process.env.LIKLO_DATA || path.join(__dirname, '..', 'data');
        fs.writeFileSync(path.join(outDir, `report-${job.bvid}.md`), job.report, 'utf8');
        console.log('report saved to data/report-' + job.bvid + '.md');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log('timed out waiting for job ' + id);
})();
