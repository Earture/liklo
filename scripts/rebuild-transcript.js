'use strict';
/**
 * Rebuild data/transcript-<bvid>.json from the ASR cache without calling the ASR
 * service or the LLM: useful after changing the merge/timestamp logic.
 *
 *   node scripts/rebuild-transcript.js BV1qXJQ64EA6
 *
 * If some segments are not in the cache they are transcribed for real, so the
 * script still works on a partially transcribed video.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const audio = require('../src/audio');
const transcribe = require('../src/transcribe');

(async function main() {
  const bvid = process.argv[2];
  if (!bvid) {
    console.error('usage: node scripts/rebuild-transcript.js <bvid>');
    process.exit(1);
  }
  const job = db.getJobByBvid(bvid);
  if (!job || !job.audio_path) {
    console.error(`no job with audio for ${bvid} in the database`);
    process.exit(1);
  }
  if (!fs.existsSync(job.audio_path)) {
    console.error(`audio file missing: ${job.audio_path}`);
    process.exit(1);
  }

  const segments = await audio.splitAudio(job.audio_path, config.MAX_SEGMENT_SECONDS);
  console.log(`split ${path.basename(job.audio_path)} into ${segments.length} segments`);

  const transcript = await transcribe.transcribeSegments(
    segments,
    (i, total, offset) => console.log(`[${i}/${total}] offset ${offset}s`),
    undefined,
    path.join(config.DATA_DIR, 'asr-cache', bvid)
  );

  const out = path.join(config.DATA_DIR, `transcript-${bvid}.json`);
  fs.writeFileSync(out, JSON.stringify(transcript, null, 2), 'utf8');
  if (job.id) db.updateJob(job.id, { transcript_path: out, transcript: transcript.text || '' });

  const covered = transcript.segments.reduce((s, x) => s + Math.max(0, (x.end || 0) - (x.start || 0)), 0);
  console.log(`wrote ${out}: ${transcript.segments.length} segments, ${transcript.text.length} chars, coverage ${covered.toFixed(1)}s`);
  const bad = transcript.segments.filter((x) => x.start == null || x.end == null || x.end < x.start || x.end > (job.duration || 1e9));
  console.log(`timestamps outside the video: ${bad.length}`);
})();
