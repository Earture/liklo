'use strict';
/*
 * Direct ASR smoke test on one segment file.
 * Usage: node scripts/test-asr.js <segmentPath> [maxSeconds]
 */
const path = require('path');
const config = require('../src/config');
const { asrTranscribe, normalizeVerbose } = require('../src/transcribe');

(async () => {
  const file = process.argv[2] || path.join(config.DATA_DIR, 'audio', '20261016_liko.seg05.m4a');
  const maxMs = Number(process.argv[3] || 20 * 60 * 1000);
  console.log('sending', file);
  const t = Date.now();
  try {
    const json = await asrTranscribe(file, AbortSignal.timeout(maxMs));
    const norm = normalizeVerbose(json);
    console.log(`elapsed ${((Date.now() - t) / 1000).toFixed(1)}s`);
    console.log('raw keys:', Object.keys(json).join(','));
    console.log('segments:', norm.segments.length, 'chars:', norm.text.length);
    console.log('first segment:', JSON.stringify(norm.segments[0]));
    console.log('text preview:', norm.text.slice(0, 200));
  } catch (e) {
    console.log('FAILED after', ((Date.now() - t) / 1000).toFixed(1), 's:', e.message);
    if (e.cause) console.log('cause:', e.cause.message || e.cause);
  }
})();
