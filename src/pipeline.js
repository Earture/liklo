'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const bilibili = require('./bilibili');
const audio = require('./audio');
const transcribe = require('./transcribe');
const report = require('./report');
const names = require('./names');
const staticsite = require('./staticsite');
const { englishName, yyyymmdd, fmtTime, NAME_STOPWORDS, partKey, transcriptPathFor, asrCacheDirFor, rawTranscriptPathFor, partUrl } = require('./util');

const GENERIC_NAMES = NAME_STOPWORDS;
const queue = [];
const active = new Map(); // jobId -> AbortController
let running = false;

function enqueue(jobId) {
  if (queue.includes(jobId)) return;
  queue.push(jobId);
  drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const job = db.getJob(id);
      if (!job || job.status === 'done' || job.status === 'cancelled') continue;
      try {
        await runJob(id);
      } catch (e) {
        db.updateJob(id, { status: 'error', error: String(e.message || e) });
      }
    }
  } finally {
    running = false;
  }
}

/** True while a job should keep working; used as a checkpoint between stages. */
function isCancelled(id) {
  const job = db.getJob(id);
  return !job || job.status === 'cancelled';
}

/**
 * Cancel a job: remove it from the queue, mark it cancelled, and abort whatever
 * it is currently doing (yt-dlp download, ASR request, LLM request).
 */
function cancelJob(id) {
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
  const job = db.getJob(id);
  if (!job) return null;
  if (job.status === 'done') return job;
  db.updateJob(id, { status: 'cancelled', stage: 'cancelled', error: null });
  const ac = active.get(id);
  if (ac) ac.abort();
  return db.getJob(id);
}

/**
 * Start a job that exists but was never run — the parts 2+ of a multi-P video, which
 * are created as 'ready' and only transcribed on demand — or retry one that failed or
 * was cancelled.
 */
function startJob(id) {
  const job = db.getJob(id);
  if (!job) return null;
  if (job.status === 'done' || active.has(id)) return job;
  db.updateJob(id, { status: 'pending', stage: 'queued', error: null });
  enqueue(id);
  return db.getJob(id);
}

/**
 * Remove every file a job produced. Segment files are pure intermediates and are
 * always deleted; the downloaded audio and the transcript are kept by default so
 * the same video can be re-added later without re-downloading or re-transcribing
 * (ASR is the slow part of the pipeline). Pass purge=true to delete everything.
 */
function removeArtifacts(job, purge) {
  const removed = [];
  const unlink = (p) => {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        removed.push(p);
      } catch (e) {
        console.warn(`[job ${job.id}] could not remove ${p}: ${e.message}`);
      }
    }
  };

  if (job.audio_path && fs.existsSync(job.audio_path)) {
    const dir = path.dirname(job.audio_path);
    const stem = path.basename(job.audio_path).replace(/\.[a-zA-Z0-9]+$/, '');
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(stem)) continue;
      // intermediates: .segNN.<ext> produced by the split, and the concat list
      if (/\.seg\d+\.[a-zA-Z0-9]+$/.test(f) || f.endsWith('.concat.txt')) {
        unlink(path.join(dir, f));
      }
    }
    if (purge) unlink(job.audio_path);
  }

  if (purge) {
    unlink(transcriptPathFor(job));
    const cacheDir = asrCacheDirFor(job);
    if (fs.existsSync(cacheDir)) {
      for (const f of fs.readdirSync(cacheDir)) unlink(path.join(cacheDir, f));
      fs.rmdirSync(cacheDir);
    }
  }
  return removed;
}

/**
 * Delete a job from the list: abort whatever it is doing, drop it from the queue,
 * and remove the row. Intermediate segment files are always removed; the audio and
 * transcript are kept unless purge is true.
 */
function deleteJob(id, purge = false) {
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
  const job = db.getJob(id);
  if (!job) return null;
  const ac = active.get(id);
  if (ac) ac.abort();
  active.delete(id);
  const removed = removeArtifacts(job, purge);
  db.deleteJob(id);
  if (removed.length) console.log(`[job ${id}] deleted, removed ${removed.length} file(s)`);
  return { deleted: true, id, bvid: job.bvid, removed: removed.length };
}

/**
 * English name used for output filenames. The video title usually names the
 * VTuber of that specific stream ("莉蔻Liko 旅游第一天"), which is more accurate
 * than the UP display name ("牧场草原神official"), so the title is tried first.
 */
function resolveEnglish(info, streamer) {
  const explicit = streamer?.english;
  if (explicit && !/^\d+$/.test(String(explicit)) && !GENERIC_NAMES.has(String(explicit).toLowerCase())) {
    return String(explicit).toLowerCase();
  }
  return englishName([info.title, info.owner, streamer?.name], info.bvid);
}

/**
 * Titles of two parts of the same video with the flavour words stripped
 * (「【弹幕】」, 「无弹幕版」, 「1080P」 …). Used only to recognise a part that is
 * the same stream published twice; 「上半场」/「下半场」 stay different.
 */
function normalizePartTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/p\s*\d+/g, '')
    .replace(/弹幕版|无弹幕|纯弹幕|弹幕|纯净版|干净版|完整版|原版|备份|重上传|重传|1080p|720p|4k|高清|超清/g, '')
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

/** True when part `p` is another copy of an earlier part of the same video. */
function isDuplicatePart(info, p) {
  const a = info.parts[p - 1];
  if (!a) return false;
  const ta = normalizePartTitle(a.title);
  for (let q = 1; q < p; q++) {
    const b = info.parts[q - 1];
    const tb = normalizePartTitle(b.title);
    // parts of the same stream have (almost) the same length; halves of one stream
    // do not, so a duration mismatch is enough to keep them separate tasks
    const near = Math.abs((a.duration || 0) - (b.duration || 0)) <= Math.max(120, 0.15 * Math.max(a.duration || 0, b.duration || 0));
    if (!near) continue;
    // nothing left after stripping flavour words -> the part is only labelled
    // 「纯净版」/「无弹幕」, i.e. the same content in another flavour
    const sameTitle = (ta && tb && (ta === tb || ta.includes(tb) || tb.includes(ta))) || (!ta && !tb);
    if (sameTitle) return true;
  }
  return false;
}

/**
 * Title of one part. Part titles on B站 are usually a short flavour label
 * (「纯净版」, 「上半场」) that only makes sense next to the video title, so the job
 * title keeps both: "<video title>（P2 纯净版）".
 */
function partTitle(info, part) {
  if (info.pages.length <= 1) return info.title;
  const t = String(info.parts[part - 1]?.title || '').trim();
  if (!t || /^p\s*\d+$/i.test(t) || t === info.title) return `${info.title}（P${part}）`;
  return `${info.title}（P${part} ${t}）`;
}

/**
 * Create the jobs for a video: one per part. Only the first part is queued
 * automatically; the other parts are created as 'ready' so they can be transcribed
 * on demand (they are often the same stream in another flavour, and ASR is slow).
 * `allParts` queues every part.
 */
function createPartJobs(info, streamer, auto, allParts) {
  const english = resolveEnglish(info, streamer);
  const created = [];
  for (let part = 1; part <= info.pages.length; part++) {
    const job = db.insertJob({
      bvid: info.bvid,
      url: partUrl(info.url, part),
      title: partTitle(info, part),
      streamer_name: streamer?.name || info.owner,
      mid: streamer?.mid || info.mid,
      english,
      duration: info.parts[part - 1]?.duration || info.duration,
      parts: info.pages.length,
      part,
      duplicate: isDuplicatePart(info, part) ? 1 : 0,
      auto: auto && (part === 1 || allParts) ? 1 : 0,
    });
    if (part === 1 || allParts) {
      db.updateJob(job.id, { status: 'pending', stage: 'queued' });
      enqueue(job.id);
    } else {
      db.updateJob(job.id, { status: 'ready', stage: '未开始' });
    }
    created.push(job);
  }
  if (info.pages.length > 1) {
    console.log(
      `[job ${created[0].id}] ${info.pages.length}P video (${info.parts.map((p) => `${p.page}:${fmtTime(p.duration)}`).join(' ')})` +
        ` -> ${info.pages.length} independent tasks, P1 queued${allParts ? ', all parts queued' : ', P2+ ready on demand'}`
    );
  }
  return created;
}

async function createJob(url, { auto = 0, streamer = null, allParts = false } = {}) {
  const info = await bilibili.getVideoInfo(url);
  const existing = db.listJobsByBvid(info.bvid);
  if (existing.length) {
    // The video is known: fill in parts that were never created (a video that was
    // added as P1 only), and restart the first job if it failed or was cancelled.
    // Nothing is re-downloaded or re-transcribed by this.
    if (info.pages.length > existing.length) {
      for (let part = existing.length + 1; part <= info.pages.length; part++) {
        if (db.getJobByBvid(info.bvid, part)) continue;
        const job = db.insertJob({
          bvid: info.bvid,
          url: partUrl(info.url, part),
          title: partTitle(info, part),
          streamer_name: existing[0].streamer_name || info.owner,
          mid: existing[0].mid || info.mid,
          english: existing[0].english,
          duration: info.parts[part - 1]?.duration || info.duration,
          parts: info.pages.length,
          part,
          duplicate: isDuplicatePart(info, part) ? 1 : 0,
          auto: 0,
        });
        db.updateJob(job.id, { status: 'ready', stage: '未开始' });
        console.log(`[job ${job.id}] added P${part} of ${info.bvid} (not started)`);
      }
    }
    const first = existing[0];
    if (allParts) {
      // explicit "transcribe every part": start the parts that are still waiting
      for (const job of existing) {
        if (job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') {
          db.updateJob(job.id, { status: 'pending', stage: 'queued', error: null });
          enqueue(job.id);
        }
      }
    }
    if (first.status !== 'done') {
      db.updateJob(first.id, {
        status: 'pending',
        stage: 'queued',
        error: null,
        parts: info.pages.length,
      });
      enqueue(first.id);
    }
    return first;
  }
  return createPartJobs(info, streamer, auto, allParts)[0];
}

async function runJob(id) {
  const job = db.getJob(id);
  if (!job || job.status === 'done' || job.status === 'cancelled') return;

  const ac = new AbortController();
  active.set(id, ac);
  db.updateJob(id, { status: 'running', stage: 'downloading', error: null });

  try {
    const info = await bilibili.getVideoInfo(job.url);
    if (isCancelled(id)) return;
    // Every part of a multi-P video is its own job: this job only ever processes
    // `job.part`. The other parts are separate tasks with their own audio, transcript
    // and report, so nothing is concatenated and timestamps stay valid within a part.
    const part = Math.max(1, Number(job.part) || 1);
    const targetDuration = info.pages.length > 1 ? (info.parts[part - 1]?.duration || info.duration) : info.duration;
    db.updateJob(id, {
      title: partTitle(info, part),
      duration: targetDuration,
      parts: info.pages.length,
      part,
      streamer_name: job.streamer_name || info.owner,
    });
    if (info.pages.length > 1) {
      console.log(
        `[job ${id}] ${info.pages.length}P video (${info.parts.map((p) => `${p.page}:${fmtTime(p.duration)}`).join(' ')}), processing P${part} (${fmtTime(targetDuration)})` +
          (isDuplicatePart(info, part) ? ' — marked as a duplicate of another part' : '')
      );
    }

    // 1. download audio only, named: <current date>_<english streamer>.p<part>.ext
    const baseName = job.english
      ? `${yyyymmdd()}_${job.english}`
      : `${yyyymmdd()}_${englishName([info.title, info.owner], info.bvid)}`;
    // Reuse a previous download only if it is complete: a run killed halfway leaves a
    // truncated file, which would silently produce a partial transcript.
    let merged = job.audio_path && fs.existsSync(job.audio_path) ? job.audio_path : null;
    if (merged) {
      try {
        const have = await audio.probeDuration(merged);
        if (Math.abs(have - targetDuration) > 30) {
          // the filename is `<date>_<streamer>.m4a`, so an earlier run of a different
          // replay of the same streamer can leave a file with the same name behind:
          // only reuse audio whose duration actually matches this video.
          console.log(`[job ${id}] existing audio is not this video (${fmtTime(have)} vs ${fmtTime(targetDuration)}), re-downloading`);
          merged = null;
        }
      } catch (e) {
        console.log(`[job ${id}] existing audio unreadable (${e.message}), re-downloading`);
        merged = null;
      }
    }
    if (!merged) {
      // one directory per video: keeps <date>_<streamer>.p<part>.m4a naming while never
      // colliding with another replay of the same streamer on the same day
      const outDir = path.join(config.DOWNLOAD_DIR, info.bvid);
      const { files } = await audio.downloadAudio(partUrl(info.url, part), baseName, ac.signal, {
        outDir,
        parts: info.pages.length,
        part,
      });
      if (isCancelled(id)) return;
      // no concat step: the part this job is about is the whole audio it processes
      merged = files[0];
      db.updateJob(id, { audio_path: merged });
    } else {
      console.log(`[job ${id}] reusing downloaded audio ${merged}`);
    }
    if (isCancelled(id)) return;
    db.updateJob(id, { stage: 'splitting' });

    // 2. split into segments of at most config.MAX_SEGMENT_SECONDS (default 5 min)
    const segments = await audio.splitAudio(merged, config.MAX_SEGMENT_SECONDS);
    if (isCancelled(id)) return;
    db.updateJob(id, { stage: 'transcribing' });

    // 3. transcribe sequentially. A transcript from an earlier run of the same part is
    //    reused as-is (ASR is the slow part), so iterating on the report prompt does not
    //    re-transcribe the audio.
    const transcriptPath = transcriptPathFor(job);
    let transcript = null;
    for (const candidate of [job.transcript_path, transcriptPath]) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed && (parsed.text || (parsed.segments && parsed.segments.length))) {
          transcript = parsed;
          console.log(`[job ${id}] reusing existing transcript ${candidate}`);
          break;
        }
      } catch {
        /* ignore unreadable cache and re-transcribe */
      }
    }
    if (!transcript) {
      const asrStart = Date.now();
      transcript = await transcribe.transcribeSegments(
        segments,
        (i, total, offset, completed) => {
          // ETA from the average time of the segments already finished
          const done = completed ? i : i - 1;
          let eta = '';
          if (done > 0) {
            const elapsed = (Date.now() - asrStart) / 1000;
            const per = elapsed / done;
            eta = ` · 已用 ${Math.round(elapsed / 60)} 分钟，预计还需 ${Math.round((per * (total - done)) / 60)} 分钟`;
          }
          const stage = completed ? `transcribing ${done}/${total} 已完成${eta}` : `transcribing ${i}/${total}${eta}`;
          db.updateJob(id, { stage });
          if (!completed) console.log(`[job ${id}] ASR segment ${i}/${total} (offset ${fmtTime(offset)})${eta}`);
          else console.log(`[job ${id}] ASR segment ${i}/${total} done, ${total - i} left`);
        },
        ac.signal,
        asrCacheDirFor(job)
      );
      if (isCancelled(id)) return;
      fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
      // keep an untouched copy: name corrections are recomputed from it, never from
      // an already-corrected transcript
      fs.writeFileSync(rawTranscriptPathFor(job), JSON.stringify(transcript), 'utf8');
    }
    db.updateJob(id, { transcript_path: transcriptPath, transcript: transcript.text || '', stage: 'reporting' });

    // 4. LLM report
    const timeline = transcribe.buildTimeline(transcript);
    console.log(`[job ${id}] report input: ${timeline.length} chars (~${report.estimateTokens(timeline)} tokens)`);
    const reportText = await report.generateReport(info.title, timeline, { signal: ac.signal, duration: targetDuration });
    if (isCancelled(id)) return;
    db.updateJob(id, { status: 'done', stage: 'done', report: reportText, report_raw: reportText });

    // 5. one name-correction pass over report + transcript (see src/names.js): the
    //    deterministic scan finds words close to known names, the LLM confirms which
    //    are real ASR mishearings, and the code does the replacements.
    // the transcript is freshly transcribed here, so it is the original text
    try {
      const res = await names.correctNames(id, { reportText, signal: ac.signal });
      if (res.applied && res.applied.length) {
        console.log(
          `[job ${id}] name fixes: ${res.applied.map((f) => `${f.wrong}->${f.correct} x${f.count}`).join(', ')}`
        );
      } else {
        console.log(`[job ${id}] no name fixes (${res.reason || 'none found'})`);
      }
    } catch (e) {
      console.warn(`[job ${id}] name correction failed: ${e.message}`);
    }
    console.log(`[job ${id}] done: ${info.title}`);
    // a finished report is worth exporting: the static library is rebuilt (debounced)
    staticsite.scheduleBuild(`job ${id}`);
  } catch (e) {
    if (isCancelled(id)) {
      console.log(`[job ${id}] cancelled`);
      return;
    }
    db.updateJob(id, { status: 'error', error: String(e.message || e) });
    console.error(`[job ${id}] failed:`, e.message);
  } finally {
    active.delete(id);
  }
}

/**
 * Regenerate the LLM report from a transcript already on disk, without downloading
 * or transcribing again. Used to iterate on the report prompt quickly.
 */
async function regenerateReport(id) {
  const job = db.getJob(id);
  if (!job) return null;
  if (active.has(id)) throw new Error(`job ${id} is already running, wait for it to finish`);
  const transcriptPath = transcriptPathFor(job);
  if (!fs.existsSync(transcriptPath)) throw new Error(`no transcript for ${job.bvid}: run the job first`);
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  if (!transcript.text && !(transcript.segments && transcript.segments.length)) {
    throw new Error(`transcript for ${job.bvid} is empty`);
  }
  const timeline = transcribe.buildTimeline(transcript);
  const ac = new AbortController();
  active.set(id, ac);
  db.updateJob(id, { stage: 'reporting' });
  try {
    const reportText = await report.generateReport(job.title, timeline, { signal: ac.signal, duration: job.duration });
    db.updateJob(id, { status: 'done', stage: 'done', report: reportText, report_raw: reportText, transcript: transcript.text || '', transcript_path: transcriptPath });
    console.log(`[job ${id}] report regenerated from cached transcript (${timeline.length} chars, ~${report.estimateTokens(timeline)} tokens)`);
    try {
      const res = await names.correctNames(id, { reportText, signal: ac.signal });
      if (res.applied && res.applied.length) {
        console.log(`[job ${id}] name fixes: ${res.applied.map((f) => `${f.wrong}->${f.correct} x${f.count}`).join(', ')}`);
      }
    } catch (e) {
      console.warn(`[job ${id}] name correction failed: ${e.message}`);
    }
    staticsite.scheduleBuild(`job ${id} report`);
    return db.getJob(id);
  } finally {
    active.delete(id);
  }
}

/**
 * Drop everything the ASR step produced for a job: the merged transcript file, the
 * per-segment ASR cache, the transcript text and the name fixes recorded against it.
 * The downloaded audio and the segment files are kept, so re-transcribing only pays
 * for the ASR requests (use this after changing the ASR base/model/key).
 */
function clearTranscript(job) {
  const removed = [];
  const unlink = (p) => {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        removed.push(p);
      } catch (e) {
        console.warn(`[job ${job.id}] could not remove ${p}: ${e.message}`);
      }
    }
  };

  unlink(job.transcript_path);
  unlink(transcriptPathFor(job));

  const cacheDir = asrCacheDirFor(job);
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir)) unlink(path.join(cacheDir, f));
    try {
      fs.rmdirSync(cacheDir);
    } catch {
      /* not empty, or already gone */
    }
  }

  // stale WAV conversions from the old fallback path, if any are left behind
  if (job.audio_path && fs.existsSync(path.dirname(job.audio_path))) {
    for (const f of fs.readdirSync(path.dirname(job.audio_path))) {
      if (f.endsWith('.asr.wav')) unlink(path.join(path.dirname(job.audio_path), f));
    }
  }
  return removed;
}

/**
 * Re-transcribe a job with the ASR service currently configured: clear the transcript
 * and its cache, then re-run the pipeline (the audio and the segments are reused, the
 * report and the name correction are regenerated afterwards).
 */
function retranscribeJob(id) {
  const job = db.getJob(id);
  if (!job) return null;
  if (active.has(id)) throw new Error(`job ${id} is already running, wait for it to finish`);
  const removed = clearTranscript(job);
  db.updateJob(id, {
    status: 'pending',
    stage: 'queued',
    error: null,
    transcript: null,
    transcript_path: null,
    report: null,
    // name_fixes is NOT NULL DEFAULT ''
    name_fixes: '',
  });
  enqueue(id);
  console.log(
    `[job ${id}] transcript cleared (${removed.length} file(s)), re-transcribing with ${config.ASR_BASE}`
  );
  return db.getJob(id);
}

/**
 * Reports saved by older versions of this code have no section headings, keep the
 * chunk subheadings in the body, and carry `**发生了什么：**` labels. Those are
 * repaired from the stored text alone (no LLM), once at startup: after a report has
 * the three sections and no loose subheading it is never touched again.
 *
 * Tidying is a fixed point, not one pass: deduping a list exposes duplicates that
 * only become visible afterwards. Four passes are enough for every report in the
 * database, and the loop stops as soon as a pass changes nothing.
 */
/** When the transcript's first real utterance is, or null when there is no transcript. */
function firstSpeechOf(job) {
  const tp = transcriptPathFor(job);
  if (!tp || !fs.existsSync(tp)) return null;
  try {
    return transcribe.firstSpeechSeconds(JSON.parse(fs.readFileSync(tp, 'utf8')));
  } catch (e) {
    console.warn(`[migrate] job ${job.id}: transcript unreadable (${e.message})`);
    return null;
  }
}

function migrateReports() {
  let fixed = 0;
  for (const job of db.listJobs(200)) {
    if (!job.report) continue;
    let out = job.report;
    // the transcript decides what the opening stretch is; used both to decide whether a
    // report is canonical and, below, to anchor the first section
    const speech = firstSpeechOf(job);

    if (report.needsTidy(out, job.duration, speech)) {
      try {
        for (let i = 0; i < 4; i++) {
          const next = report.assembleReport(out, job.duration);
          if (!next || next === out) break;
          out = next;
        }
      } catch (e) {
        console.warn(`[migrate] job ${job.id} skipped: ${e.message}`);
        continue;
      }
      // The size guard protects against a rewrite that drops moments. The filler tic
      // ("仿佛X是一种需要被Y来确认的异常行为") is analysis with no moment in it, so a
      // rewrite that only removes it is not a loss of content and must not be blocked
      // by the size guard.
      const lost = job.report.length - (out ? out.length : 0);
      const fillerChars = report.fillerSentences(job.report).reduce((n, s) => n + s.length, 0);
      if (!out || lost > Math.max(job.report.length * 0.3, fillerChars)) {
        console.warn(
          `[migrate] job ${job.id} skipped: rewrite lost too much text (${job.report.length} -> ${out ? out.length : 0})`
        );
        continue;
      }
    }

    // A report generated before the timeline skipped silence anchors opens its first
    // section at a stretch where nobody speaks. Done after the assembler on purpose: the
    // assembler builds spans from the items it files, so anchoring first would be
    // undone by it. No model call, and it changes nothing when already correct.
    const anchored = report.anchorOpening(out, speech);
    if (anchored !== out) {
      out = anchored;
      console.log(`[migrate] job ${job.id}: opening section re-anchored to the first utterance`);
    }

    if (out !== job.report) {
      db.updateJob(job.id, { report: out });
      fixed++;
    }
  }
  if (fixed) staticsite.scheduleBuild('report repair');
  return fixed;
}

module.exports = {
  enqueue,
  createJob,
  runJob,
  startJob,
  cancelJob,
  deleteJob,
  regenerateReport,
  retranscribeJob,
  migrateReports,
  partKey,
  transcriptPathFor,
  asrCacheDirFor,
};
