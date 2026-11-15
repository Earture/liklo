'use strict';
/**
 * Regenerate the LLM report from a transcript that is already on disk.
 * No download, no ASR - use this while iterating on the report prompt.
 *
 * usage:
 *   node scripts/report-only.js <jobId|bvid>
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const pipeline = require('../src/pipeline');

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/report-only.js <jobId|bvid>');
    process.exit(1);
  }
  const id = /^\d+$/.test(arg) ? Number(arg) : (db.getJobByBvid(arg) || {}).id;
  if (!id) {
    console.error('job not found:', arg);
    process.exit(1);
  }
  const job = await pipeline.regenerateReport(id);
  const out = path.join(config.DATA_DIR, `report-${job.bvid}.md`);
  fs.writeFileSync(out, job.report || '', 'utf8');
  console.log(job.report || '');
  console.log(`\n[saved] ${out}`);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
