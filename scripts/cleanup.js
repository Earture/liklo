'use strict';
/**
 * Clean up artifacts left behind by runs that were stopped halfway
 * (cancelled / errored / killed processes), so a fresh test run starts clean.
 *
 * usage:
 *   node scripts/cleanup.js                 # remove partial segment files of unfinished jobs
 *   node scripts/cleanup.js --dry-run       # only show what would be removed
 *   node scripts/cleanup.js --all           # also remove segment files of finished jobs
 *   node scripts/cleanup.js --purge-cache   # also delete transcripts and data/asr-cache
 *   node scripts/cleanup.js --keep-audio    # keep downloaded .m4a files (default: only orphans removed)
 *
 * Transcripts and ASR cache are kept by default: they are complete results and are
 * reused by later runs (ASR is the slow part of the pipeline).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const purgeCache = args.includes('--purge-cache');
const keepAudio = args.includes('--keep-audio');

const isSegment = (f) => /\.seg\d+\.[a-z0-9]+$/i.test(f);
const audioExts = /\.(m4a|mp3|aac|opus|webm|wav)$/i;

function removeFile(p) {
  if (!fs.existsSync(p)) return 0;
  const size = fs.statSync(p).size;
  if (!dryRun) fs.unlinkSync(p);
  return size;
}

function removeDir(p) {
  if (!fs.existsSync(p)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(p)) total += removeFile(path.join(p, f));
  if (!dryRun && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  return total;
}

const db = new DatabaseSync(config.DB_PATH);
const jobs = db.prepare('SELECT id, bvid, status, audio_path FROM jobs').all();
// Jobs that are not finished and not currently in progress: cancelled, errored, or still queued.
const unfinished = (j) => j.status === 'cancelled' || j.status === 'error' || j.status === 'pending';
const wanted = all ? jobs : jobs.filter(unfinished);

let removed = 0;
let bytes = 0;

function report(kind, p, size) {
  if (!size) return;
  removed++;
  bytes += size;
  console.log(`${dryRun ? 'would remove' : 'removed'} ${kind}: ${p} (${(size / 1024).toFixed(0)} KB)`);
}

// 1. segment files for the selected jobs; transcripts + ASR cache only when --purge-cache
for (const job of wanted) {
  if (job.audio_path) {
    const dir = path.dirname(job.audio_path);
    const stem = path.basename(job.audio_path).replace(/\.[a-zA-Z0-9]+$/, '');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.startsWith(stem) || !isSegment(f)) continue;
      report('segment', path.join(dir, f), removeFile(path.join(dir, f)));
    }
  }
  if (purgeCache) {
    const tp = path.join(config.DATA_DIR, `transcript-${job.bvid}.json`);
    report('transcript', tp, removeFile(tp));
    report('asr-cache', path.join(config.DATA_DIR, 'asr-cache', job.bvid), removeDir(path.join(config.DATA_DIR, 'asr-cache', job.bvid)));
  }
}

// 2. orphan audio files: not referenced by any job and not a segment of one
const keep = new Set();
const keepStems = new Set();
for (const job of jobs) {
  if (!job.audio_path) continue;
  keep.add(path.resolve(job.audio_path));
  keepStems.add(path.basename(job.audio_path).replace(/\.[a-zA-Z0-9]+$/, ''));
}
if (fs.existsSync(config.DOWNLOAD_DIR)) {
  for (const f of fs.readdirSync(config.DOWNLOAD_DIR)) {
    const p = path.resolve(path.join(config.DOWNLOAD_DIR, f));
    if (keep.has(p)) continue;
    if (!audioExts.test(f)) continue;
    const stem = f.replace(/\.[a-zA-Z0-9]+$/, '').replace(/\.seg\d+$/i, '');
    if (keepStems.has(stem)) continue; // belongs to a job; handled above
    if (keepAudio && !isSegment(f)) continue;
    report('orphan audio', p, removeFile(p));
  }
}

// 3. reset stages of unfinished jobs so they start from scratch (transcript cache is kept)
if (!dryRun && wanted.length) {
  for (const job of wanted) {
    if (job.status === 'done') continue;
    db.prepare('UPDATE jobs SET stage = ?, error = NULL WHERE id = ?').run('queued', job.id);
  }
}

console.log(
  `${dryRun ? 'would remove' : 'removed'} ${removed} file(s), ${(bytes / 1048576).toFixed(1)} MB` +
  ` (${wanted.length} unfinished job(s)${all ? ', including finished ones' : ''})`
);
