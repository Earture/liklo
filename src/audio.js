'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { run, ensureDir } = require('./util');

const AUDIO_EXT_RE = /\.(m4a|mp3|aac|opus|webm|wav)$/i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of a part in a yt-dlp multi-part output name (`name.3.m4a` -> 3), 0 otherwise. */
function partIndex(name) {
  const m = /\.(\d+)\.[a-zA-Z0-9]+$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Download audio-only for one part of a Bilibili video with yt-dlp.
 *
 * `outDir` is a per-video directory: without it two replays of the same streamer on the
 * same day share one filename (`<date>_<name>.m4a`) and the second download silently
 * overwrites the first, and the first one's `.segNN` files are then mistaken for extra
 * parts of the second video.
 * `part` (1-based) selects which part of a multi-P video to fetch: each part is its own
 * file (`<baseName>.p2.m4a`), so parts are never concatenated and the timestamps of a
 * transcript stay inside the part they belong to.
 * Returns { files, baseName }.
 */
async function downloadAudio(url, baseName, signal, opts = {}) {
  const outDir = opts.outDir || config.DOWNLOAD_DIR;
  ensureDir(outDir);
  const parts = Math.max(1, Number(opts.parts) || 1);
  const part = Math.max(1, Number(opts.part) || 1);
  const stem = parts > 1 ? `${baseName}.p${part}` : baseName;
  const outPattern = path.join(outDir, `${stem}.%(ext)s`);
  const args = [
    '-f', 'ba',
    '-o', outPattern,
    '--no-part',
    '--force-overwrites',
  ];
  // restrict the anthology playlist to the part this job is about, so yt-dlp never
  // downloads the other parts
  if (parts > 1) args.push('--playlist-items', String(part));
  args.push(url);
  if (fs.existsSync(config.COOKIE_FILE)) args.push('--cookies', config.COOKIE_FILE);
  const { stderr } = await run(config.YTDLP, args, { timeout: 30 * 60 * 1000, signal });

  // only the file yt-dlp just wrote: a bare `startsWith(baseName)` match also picks up
  // .segNN files left by an earlier run with the same name, which makes a single-part
  // video look multi-part and sends it through the concat step. The `(?:\.1)?` accepts
  // the part-indexed name an older "all parts" run produced for P1.
  const ext = '(m4a|mp3|aac|opus|webm|wav)';
  const wanted = parts > 1
    ? new RegExp('^' + escapeRe(stem) + '\\.' + ext + '$', 'i')
    : new RegExp('^' + escapeRe(stem) + '(?:\\.1)?\\.' + ext + '$', 'i');
  const files = fs
    .readdirSync(outDir)
    .filter((f) => wanted.test(f))
    .sort((a, b) => partIndex(a) - partIndex(b))
    .map((f) => path.join(outDir, f));
  if (!files.length) throw new Error(`yt-dlp produced no audio file for ${url}: ${stderr.slice(0, 400)}`);
  return { files, baseName: stem };
}

async function probeDuration(file) {
  const { stdout } = await run(config.FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(stdout || '{}');
  const d = Number(j.format?.duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`cannot probe duration: ${file}`);
  return d;
}

/** Concatenate multi-part downloads into one file using the ffmpeg concat demuxer. */
async function concatFiles(files, outPath) {
  if (files.length === 1) return files[0];
  const dir = path.dirname(outPath);
  // ffmpeg's concat demuxer with `-safe 1` rejects any name that is not alnum/._-/ so
  // absolute Windows paths ("C:\..." or "C:/...") are "unsafe". Listing the parts by
  // relative name and running ffmpeg in that directory avoids the problem.
  const listPath = path.join(dir, 'concat-list.txt');
  const names = files.map((f) => path.relative(dir, f).replace(/\\/g, '/').replace(/'/g, ''));
  fs.writeFileSync(listPath, names.map((f) => `file '${f}'`).join('\n') + '\n', 'utf8');
  await run(
    config.FFMPEG,
    ['-y', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', listPath, '-c', 'copy', outPath],
    { timeout: 10 * 60 * 1000, cwd: dir }
  );
  fs.unlinkSync(listPath);
  return outPath;
}

/**
 * Split audio into segments of at most maxSeconds. Returns list of { path, offset, duration }.
 *
 * Notes:
 *  - `-y` is required: without it ffmpeg asks "File already exists. Overwrite? [y/N]" on
 *    stdin, which never answers when spawned from a program, so the job hangs forever.
 *  - Segments already produced by a previous run are reused (only validated with ffprobe),
 *    so resuming a cancelled/restarted job does not re-split the file.
 */
async function splitAudio(file, maxSeconds) {
  const duration = await probeDuration(file);
  if (duration <= maxSeconds + 1) {
    return [{ path: file, offset: 0, duration }];
  }
  const stem = file.replace(/\.[a-zA-Z0-9]+$/, '');
  const ext = path.extname(file);
  const segments = [];
  for (let start = 0; start < duration; start += maxSeconds) {
    const segPath = `${stem}.seg${String(Math.floor(start / maxSeconds) + 1).padStart(2, '0')}${ext}`;
    const expected = Math.min(maxSeconds, duration - start);
    if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
      try {
        const d = await probeDuration(segPath);
        // reuse only when the existing segment matches the expected length exactly,
        // otherwise segments from a previous (e.g. 15-minute) split would overlap
        if (Math.abs(d - expected) <= 2) {
          segments.push({ path: segPath, offset: start, duration: d });
          continue;
        }
      } catch {
        /* fall through and re-split this segment */
      }
    }
    await run(
      config.FFMPEG,
      [
        '-y',
        '-v',
        'error',
        '-ss',
        String(start),
        '-t',
        String(expected),
        '-i',
        file,
        '-c',
        'copy',
        segPath,
      ],
      { timeout: 5 * 60 * 1000 }
    );
    segments.push({ path: segPath, offset: start, duration: expected });
  }
  return segments;
}

module.exports = { downloadAudio, probeDuration, concatFiles, splitAudio };
