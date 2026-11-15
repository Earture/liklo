'use strict';
/**
 * Audio cache housekeeping.
 *
 * The pipeline keeps the downloaded audio after a job finishes so the same replay can
 * be re-transcribed later without re-downloading it. Once a report exists the audio is
 * dead weight: the transcript, the ASR cache and the report are what the UI reads. This
 * module measures what is in data/audio and deletes the audio of finished jobs (plus the
 * leftovers of videos that are no longer in the job list).
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

const AUDIO_EXT_RE = /\.(m4a|mp3|aac|opus|webm|wav)$/i;
// intermediates: the 5-minute pieces produced by the split, the ffmpeg concat list,
// and the wav files the ASR step writes before calling the transcription service
const INTERMEDIATE_RE = /(\.seg\d+\.[a-zA-Z0-9]+|\.asr\.wav|\.concat\.txt)$/i;

function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** { bytes, files } of a directory subtree; zeros when the directory does not exist. */
function dirStats(dir) {
  const out = { bytes: 0, files: 0 };
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const r = dirStats(p);
      out.bytes += r.bytes;
      out.files += r.files;
    } else {
      out.bytes += st.size;
      out.files++;
    }
  }
  return out;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** audio_path -> every status of a job that points at that file (flat names can collide) */
function indexPaths(jobs) {
  const byPath = new Map();
  for (const job of jobs) {
    if (!job.audio_path) continue;
    if (!byPath.has(job.audio_path)) byPath.set(job.audio_path, []);
    byPath.get(job.audio_path).push(job.status);
  }
  return byPath;
}

/**
 * Sizes of everything under data/audio, split into
 *   clearable  - audio of jobs whose report is already generated
 *   kept       - audio of queued / running / failed / cancelled jobs
 *   orphan     - audio of videos that are no longer in the job list
 * plus the ASR cache and the transcript JSONs, which are never touched here.
 */
function stats() {
  const root = config.DOWNLOAD_DIR;
  const jobs = db.listJobs(1000);
  const byPath = indexPaths(jobs);
  const byBvid = new Map();
  for (const job of jobs) {
    if (!byBvid.has(job.bvid)) byBvid.set(job.bvid, []);
    byBvid.get(job.bvid).push(job.status);
  }

  const total = dirStats(root);
  const clearable = { bytes: 0, files: 0 };
  const kept = { bytes: 0, files: 0 };
  const orphan = { bytes: 0, files: 0 };
  const top = [];

  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      const st = fs.statSync(p);
      const bucket = st.isDirectory() ? dirStats(p) : { bytes: st.size, files: 1 };
      const statuses = st.isDirectory()
        ? (byBvid.get(name) || [])
        : (byPath.get(p) || []);
      if (!statuses.length) {
        orphan.bytes += bucket.bytes;
        orphan.files += bucket.files;
      } else if (statuses.every((s) => s === 'done')) {
        clearable.bytes += bucket.bytes;
        clearable.files += bucket.files;
      } else {
        kept.bytes += bucket.bytes;
        kept.files += bucket.files;
      }
      if (bucket.bytes > 0) top.push({ name, bytes: bucket.bytes, status: statuses.length ? (statuses.every((s) => s === 'done') ? 'done' : 'kept') : 'orphan' });
    }
  }

  top.sort((a, b) => b.bytes - a.bytes);

  const asrCache = dirStats(path.join(config.DATA_DIR, 'asr-cache'));
  let transcriptBytes = 0;
  let transcriptFiles = 0;
  if (fs.existsSync(config.DATA_DIR)) {
    for (const name of fs.readdirSync(config.DATA_DIR)) {
      if (!/^transcript-.*\.json$/.test(name)) continue;
      transcriptBytes += statSize(path.join(config.DATA_DIR, name));
      transcriptFiles++;
    }
  }

  return {
    root,
    exists: fs.existsSync(root),
    totalBytes: total.bytes,
    totalFiles: total.files,
    clearableBytes: clearable.bytes,
    clearableFiles: clearable.files,
    keptBytes: kept.bytes,
    keptFiles: kept.files,
    orphanBytes: orphan.bytes,
    orphanFiles: orphan.files,
    asrCache,
    transcriptBytes,
    transcriptFiles,
    doneJobs: jobs.filter((j) => j.status === 'done').length,
    fmt: {
      total: fmtBytes(total.bytes),
      clearable: fmtBytes(clearable.bytes),
      kept: fmtBytes(kept.bytes),
      orphan: fmtBytes(orphan.bytes),
      asrCache: fmtBytes(asrCache.bytes),
      transcripts: fmtBytes(transcriptBytes),
    },
    top: top.slice(0, 8),
  };
}

/**
 * Delete the audio of every finished job. Segment files, concat lists and the
 * `.asr.wav` intermediates go with it, and directories of videos that are no longer
 * in the job list are removed as well. Transcripts, ASR cache and reports are left
 * alone, so a report stays readable; 「重新转录」 on a cleared job re-downloads the
 * audio from B站.
 */
function clearAudioCache(opts = {}) {
  const { includeOrphans = true } = opts;
  const root = config.DOWNLOAD_DIR;
  const jobs = db.listJobs(1000);
  const byPath = indexPaths(jobs);

  let bytes = 0;
  let files = 0;
  let dirsRemoved = 0;
  const removed = [];

  const unlink = (p) => {
    const size = statSize(p);
    if (!size) return;
    try {
      fs.unlinkSync(p);
      bytes += size;
      files++;
      removed.push(p);
    } catch (e) {
      console.warn(`[cache] could not remove ${p}: ${e.message}`);
    }
  };

  const removeTree = (dir) => {
    const s = dirStats(dir);
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) removeTree(p);
      else unlink(p);
    }
    try {
      fs.rmdirSync(dir);
      dirsRemoved++;
    } catch {
      /* someone else still has a file open there */
    }
    return s;
  };

  // 1. audio of finished jobs, plus the split pieces next to it
  for (const job of jobs) {
    if (job.status !== 'done' || !job.audio_path) continue;
    if (!fs.existsSync(job.audio_path)) continue;
    // an unfinished job of the same video may share the file (older flat naming)
    if ((byPath.get(job.audio_path) || []).some((s) => s !== 'done')) continue;
    unlink(job.audio_path);

    const dir = path.dirname(job.audio_path);
    const stem = path.basename(job.audio_path).replace(/\.[a-zA-Z0-9]+$/, '');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) continue;
      if (f.startsWith(stem) && INTERMEDIATE_RE.test(f)) unlink(p);
    }
  }

  // 2. intermediates anywhere under the audio directory: they are never read again
  const busy = new Set(jobs.filter((j) => j.status === 'running' || j.status === 'pending')
    .map((j) => (j.audio_path ? path.dirname(j.audio_path) : null)).filter(Boolean));
  if (fs.existsSync(root)) {
    const sweep = (dir) => {
      if (busy.has(dir)) return; // a job is mid-split here, its segments are still in use
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) sweep(p);
        else if (INTERMEDIATE_RE.test(name)) unlink(p);
      }
    };
    sweep(root);
  }

  // 3. directories of videos that are no longer in the job list
  if (includeOrphans && fs.existsSync(root)) {
    const knownDirs = new Set();
    for (const job of jobs) {
      if (job.audio_path) knownDirs.add(path.dirname(job.audio_path));
    }
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (!knownDirs.has(p)) removeTree(p);
      } else if (AUDIO_EXT_RE.test(name) && !byPath.has(p)) {
        unlink(p);
      }
    }
  }

  // 4. empty directories left behind
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      if (fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) {
        try {
          fs.rmdirSync(p);
          dirsRemoved++;
        } catch {
          /* ignore */
        }
      }
    }
  }

  console.log(`[cache] cleared ${files} files (${fmtBytes(bytes)}) of finished jobs, ${dirsRemoved} empty/orphan directories`);
  return {
    removedFiles: files,
    removedBytes: bytes,
    removed: fmtBytes(bytes),
    dirsRemoved,
    root,
    after: stats(),
  };
}

module.exports = { stats, clearAudioCache, fmtBytes };
