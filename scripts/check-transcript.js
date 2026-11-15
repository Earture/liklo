'use strict';
// Validate a merged transcript: absolute timestamps, coverage, speaker labels.
// Usage: node scripts/check-transcript.js <bvid>
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const bvid = process.argv[2];
if (!bvid) {
  console.error('usage: node scripts/check-transcript.js <bvid>');
  process.exit(1);
}

const file = path.join(config.DATA_DIR, `transcript-${bvid}.json`);
if (!fs.existsSync(file)) {
  console.error(`no transcript: ${file}`);
  process.exit(1);
}
const t = JSON.parse(fs.readFileSync(file, 'utf8'));
const segs = t.segments || [];
const cacheDir = path.join(config.DATA_DIR, 'asr-cache', bvid);
const cached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];

let prevEnd = -1;
let bad = 0;
let maxGap = 0;
let speakers = new Set();
for (const s of segs) {
  if (s.start == null || s.end == null) { bad++; continue; }
  if (s.end < s.start) bad++;
  if (s.start < prevEnd - 1) bad++;
  maxGap = Math.max(maxGap, s.start - prevEnd);
  prevEnd = s.end;
  if (s.speaker) speakers.add(s.speaker);
}

console.log(JSON.stringify({
  file,
  segments: segs.length,
  chars: (t.text || '').length,
  coveredSeconds: prevEnd,
  declaredDuration: t.duration ?? null,
  badTimestamps: bad,
  largestGapSeconds: Number(maxGap.toFixed(2)),
  speakers: [...speakers],
  asrCacheFiles: cached.length,
  first: segs[0],
  last: segs[segs.length - 1],
}, null, 2));
