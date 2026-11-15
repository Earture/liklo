'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { ensureDir } = require('./util');

ensureDir(config.DATA_DIR);
const db = new DatabaseSync(config.DB_PATH);

// WAL so the read-only public server (src/public-server.js) can read reports while
// the main server writes job progress.
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    english TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '录播,直播,录像,replay',
    match TEXT NOT NULL DEFAULT '',
    monitor INTEGER NOT NULL DEFAULT 0,
    last_check_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    english TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    -- spellings the ASR has actually produced for this name, learned from confirmed
    -- corrections (see learnMishearings in src/names.js) or entered by the user
    mishearings TEXT NOT NULL DEFAULT '',
    -- forms the user removed from that list: the learner never adds them back
    mishearings_removed TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    streamer_name TEXT,
    mid TEXT,
    english TEXT,
    duration INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    stage TEXT,
    audio_path TEXT,
    transcript_path TEXT,
    transcript TEXT,
    report TEXT,
    error TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- one job per part of a multi-P video; duplicate marks a part whose title is the
    -- same stream in another flavour (弹幕版 / 无弹幕版): created, but never run
    -- automatically
    part INTEGER NOT NULL DEFAULT 1,
    parts INTEGER NOT NULL DEFAULT 1,
    duplicate INTEGER NOT NULL DEFAULT 0,
    UNIQUE (bvid, part)
  );
`);

// migration: older databases may not have the transcript column
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name);
if (!jobCols.includes('transcript')) db.exec('ALTER TABLE jobs ADD COLUMN transcript TEXT');

const streamerCols = db.prepare('PRAGMA table_info(streamers)').all().map((r) => r.name);
if (!streamerCols.includes('match')) db.exec("ALTER TABLE streamers ADD COLUMN match TEXT NOT NULL DEFAULT ''");

// per-job override for multi-part videos (1 = download/transcribe every part), and the
// number of parts of the source video (1 for single-P)
if (!jobCols.includes('all_parts')) db.exec('ALTER TABLE jobs ADD COLUMN all_parts INTEGER NOT NULL DEFAULT 0');
if (!jobCols.includes('parts')) db.exec('ALTER TABLE jobs ADD COLUMN parts INTEGER NOT NULL DEFAULT 1');
// JSON array of name corrections applied to this report/transcript: [{wrong, correct, count}]
if (!jobCols.includes('name_fixes')) db.exec("ALTER TABLE jobs ADD COLUMN name_fixes TEXT NOT NULL DEFAULT ''");
if (!jobCols.includes('part')) db.exec('ALTER TABLE jobs ADD COLUMN part INTEGER NOT NULL DEFAULT 1');
if (!jobCols.includes('duplicate')) db.exec('ALTER TABLE jobs ADD COLUMN duplicate INTEGER NOT NULL DEFAULT 0');
// the report exactly as the LLM wrote it, before any name correction. Name fixes are
// always re-derived from this copy, so editing the name table can never mangle a report
// by turning a correct spelling back into a wrong one.
if (!jobCols.includes('report_raw')) db.exec('ALTER TABLE jobs ADD COLUMN report_raw TEXT');

const nameCols = db.prepare('PRAGMA table_info(names)').all().map((r) => r.name);
if (!nameCols.includes('mishearings')) db.exec("ALTER TABLE names ADD COLUMN mishearings TEXT NOT NULL DEFAULT ''");
if (!nameCols.includes('mishearings_removed')) db.exec("ALTER TABLE names ADD COLUMN mishearings_removed TEXT NOT NULL DEFAULT ''");

// The first schema had `bvid UNIQUE`, which cannot hold one row per part of a multi-P
// video. SQLite cannot drop a constraint in place, so the table is rebuilt once when that
// index still exists. Existing rows keep part = 1 and are otherwise untouched: nothing is
// re-downloaded or re-transcribed because of this migration.
const bvidUniqueOnly = db.prepare('PRAGMA index_list(jobs)').all().some((idx) => {
  if (!idx.unique) return false;
  const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name);
  return cols.length === 1 && cols[0] === 'bvid';
});
if (bvidUniqueOnly) {
  db.exec(`
    CREATE TABLE jobs_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      streamer_name TEXT,
      mid TEXT,
      english TEXT,
      duration INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      stage TEXT,
      audio_path TEXT,
      transcript_path TEXT,
      transcript TEXT,
      report TEXT,
      error TEXT,
      auto INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      all_parts INTEGER NOT NULL DEFAULT 0,
      name_fixes TEXT NOT NULL DEFAULT '',
      part INTEGER NOT NULL DEFAULT 1,
      parts INTEGER NOT NULL DEFAULT 1,
      duplicate INTEGER NOT NULL DEFAULT 0,
      UNIQUE (bvid, part)
    );
    INSERT INTO jobs_v2 (id, bvid, url, title, streamer_name, mid, english, duration, status, stage,
                         audio_path, transcript_path, transcript, report, error, auto, created_at, updated_at,
                         all_parts, name_fixes, part, parts, duplicate)
      SELECT id, bvid, url, title, streamer_name, mid, english, duration, status, stage,
             audio_path, transcript_path, transcript, report, error, auto, created_at, updated_at,
             COALESCE(all_parts, 0), COALESCE(name_fixes, ''), COALESCE(part, 1), COALESCE(parts, 1), COALESCE(duplicate, 0)
      FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v2 RENAME TO jobs;
  `);
  console.log('[db] jobs table rebuilt: one row per (bvid, part)');
}

function upsertStreamer({ mid, name, english, keywords, match, monitor }) {
  db.prepare(
    `INSERT INTO streamers (mid, name, english, keywords, match, monitor)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mid) DO UPDATE SET
       name = excluded.name,
       english = excluded.english,
       keywords = excluded.keywords,
       match = excluded.match,
       monitor = excluded.monitor`
  ).run(String(mid), name, english, keywords || '录播,直播,录像,replay', match || '', monitor ? 1 : 0);
  return getStreamer(mid);
}

function getStreamer(mid) {
  return db.prepare('SELECT * FROM streamers WHERE mid = ?').get(String(mid)) || null;
}

function listStreamers() {
  return db.prepare('SELECT * FROM streamers ORDER BY id').all();
}

function setMonitor(mid, on) {
  db.prepare('UPDATE streamers SET monitor = ? WHERE mid = ?').run(on ? 1 : 0, String(mid));
  return getStreamer(mid);
}

function deleteStreamer(mid) {
  db.prepare('DELETE FROM streamers WHERE mid = ?').run(String(mid));
  return { deleted: true, mid: String(mid) };
}

function insertJob({ bvid, url, title, streamer_name, mid, english, duration = null, auto = 0, parts = 1, part = 1, duplicate = 0 }) {
  const info = db.prepare(
    `INSERT INTO jobs (bvid, url, title, streamer_name, mid, english, duration, auto, parts, part, duplicate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bvid,
    url,
    title || null,
    streamer_name || null,
    mid || null,
    english || null,
    duration ? Math.max(0, Number(duration) || 0) : null,
    auto ? 1 : 0,
    Math.max(1, Number(parts) || 1),
    Math.max(1, Number(part) || 1),
    duplicate ? 1 : 0
  );
  return getJob(info.lastInsertRowid);
}

function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

/** A multi-P video has one job per part; without `part` the first part is meant. */
function getJobByBvid(bvid, part = 1) {
  return db.prepare('SELECT * FROM jobs WHERE bvid = ? AND part = ?').get(bvid, Math.max(1, Number(part) || 1)) || null;
}

/** Every job of one bvid, ordered by part. */
function listJobsByBvid(bvid) {
  return db.prepare('SELECT * FROM jobs WHERE bvid = ? ORDER BY part').all(bvid);
}

/**
 * Jobs for the admin task list.
 * Accepts either a plain limit (kept for older callers) or { limit, offset, status }
 * so the UI can page through a long list and filter by status.
 */
function listJobs(options = {}) {
  const { limit = 50, offset = 0, status = null } = typeof options === 'number' ? { limit: options } : options;
  const where = [];
  const args = [];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  args.push(Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0));
  return db.prepare(
    `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args);
}

/** How many jobs match a filter (for the pagination controls). */
function countJobs(status = null) {
  // only bind a parameter when there is a filter: binding `undefined` is not allowed
  const row = status
    ? db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status = ?').get(status)
    : db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
  return row ? row.n : 0;
}

/** Jobs per status, so the task list can show how many are in each state. */
function jobStatusCounts() {
  const out = {};
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) out[row.status] = row.n;
  return out;
}

/** Completed reports only, for the report library page. */
function listReports({ limit = 200, streamer = null, q = null } = {}) {
  const where = ["status = 'done'", "report IS NOT NULL", "report <> ''"];
  const args = [];
  if (streamer) {
    where.push('(streamer_name = ? OR english = ?)');
    args.push(streamer, streamer);
  }
  if (q) {
    where.push('(title LIKE ? OR bvid LIKE ? OR streamer_name LIKE ? OR english LIKE ? OR report LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  args.push(limit);
  return db.prepare(
    `SELECT id, bvid, url, title, streamer_name, english, mid, duration, part, parts, duplicate,
            created_at, updated_at, report, name_fixes,
            (transcript IS NOT NULL OR transcript_path IS NOT NULL) AS has_transcript
     FROM jobs WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).all(...args);
}

function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getJob(id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return getJob(id);
}

function deleteJob(id) {
  const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return info.changes > 0;
}

function knownBvids(opts = {}) {
  // Cancelled jobs are normally kept in the set (the user cancelled them on
  // purpose), but monitor passes can pass excludeCancelled to re-discover them.
  const where = opts.excludeCancelled ? "WHERE status <> 'cancelled'" : '';
  return new Set(db.prepare(`SELECT bvid FROM jobs ${where}`).all().map((r) => r.bvid));
}

/** Jobs left in 'running' by a previous process are re-queued (runJob resumes). */
function recoverInterruptedJobs() {
  const rows = db.prepare("SELECT id FROM jobs WHERE status IN ('running','pending') AND status <> 'done'").all();
  db.prepare("UPDATE jobs SET status = 'pending', stage = NULL, error = NULL WHERE status IN ('running','pending')").run();
  return rows.map((r) => r.id);
}

/** Name table used by the name-correction pass (src/names.js). */
function listNames() {
  return db.prepare('SELECT * FROM names ORDER BY source DESC, name').all();
}

function getName(name) {
  return db.prepare('SELECT * FROM names WHERE name = ?').get(String(name)) || null;
}

/**
 * Insert or update a name. `aliases` is a comma-separated list of alternative
 * spellings (nicknames, latin forms), `mishearings` the spellings the ASR is known
 * to produce for it. Existing aliases are merged, never dropped, so auto-detected
 * names from titles cannot wipe out user edits.
 */
function upsertName({ name, english = '', aliases = '', mishearings = '', note = '', source = 'user' }) {
  name = String(name || '').trim();
  if (!name) return null;
  const existing = getName(name);
  if (existing) {
    const merged = mergeList(existing.aliases, aliases);
    db.prepare(
      `UPDATE names SET english = ?, aliases = ?, mishearings = ?, note = ?, source = ?, updated_at = datetime('now') WHERE name = ?`
    ).run(
      String(english || existing.english || '').trim(),
      merged,
      mergeList(existing.mishearings, mishearings),
      String(note || existing.note || '').trim(),
      existing.source === 'user' ? 'user' : source,
      name
    );
    return getName(name);
  }
  db.prepare(
    'INSERT INTO names (name, english, aliases, mishearings, note, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, String(english || '').trim(), mergeList('', aliases), mergeList('', mishearings), String(note || '').trim(), source);
  return getName(name);
}

/** add known ASR mishearings to a name without touching its other fields */
function addMishearings(name, wrongs) {
  name = String(name || '').trim();
  if (!name) return null;
  const row = getName(name);
  if (!row) return null;
  // a form the user removed on purpose is never learned again
  const blocked = new Set(String(row.mishearings_removed || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const list = (Array.isArray(wrongs) ? wrongs : String(wrongs || '').split(','))
    .map((x) => String(x).trim())
    .filter((x) => x && !blocked.has(x.toLowerCase()));
  if (!list.length) return row;
  const merged = mergeList(row.mishearings, list.join(','));
  if (merged === row.mishearings) return row;
  db.prepare("UPDATE names SET mishearings = ?, updated_at = datetime('now') WHERE name = ?").run(merged, name);
  return getName(name);
}

function mergeList(a, b) {
  const out = [];
  for (const s of [a, b]) {
    for (const part of String(s || '').split(',')) {
      const v = part.trim();
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out.join(', ');
}

function deleteName(id) {
  const info = db.prepare('DELETE FROM names WHERE id = ?').run(id);
  return info.changes > 0;
}

function updateName(id, fields) {
  const row = db.prepare('SELECT * FROM names WHERE id = ?').get(id);
  if (!row) return null;
  const next = {
    name: fields.name !== undefined ? String(fields.name).trim() : row.name,
    english: fields.english !== undefined ? String(fields.english).trim() : row.english,
    aliases: fields.aliases !== undefined ? mergeList('', fields.aliases) : row.aliases,
    mishearings: fields.mishearings !== undefined ? mergeList('', fields.mishearings) : row.mishearings,
    note: fields.note !== undefined ? String(fields.note).trim() : row.note,
  };
  if (!next.name) return null;
  // forms the user deleted from the 常见错误 list are remembered so the learner
  // (which rebuilds that list from confirmed corrections) does not add them back
  let removed = row.mishearings_removed || '';
  if (fields.mishearings !== undefined) {
    const keep = new Set(next.mishearings.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
    const dropped = String(row.mishearings || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x && !keep.has(x.toLowerCase()));
    removed = mergeList(removed, dropped.join(','));
  }
  db.prepare(
    `UPDATE names SET name = ?, english = ?, aliases = ?, mishearings = ?, mishearings_removed = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(next.name, next.english, next.aliases, next.mishearings, removed, next.note, id);
  return db.prepare('SELECT * FROM names WHERE id = ?').get(id);
}

function upsertJobNameFixes(id, fixes) {
  return updateJob(id, { name_fixes: JSON.stringify(fixes) });
}

module.exports = {
  db,
  upsertStreamer,
  getStreamer,
  listStreamers,
  setMonitor,
  deleteStreamer,
  insertJob,
  getJob,
  getJobByBvid,
  listJobsByBvid,
  listJobs,
  countJobs,
  jobStatusCounts,
  listReports,
  updateJob,
  deleteJob,
  knownBvids,
  recoverInterruptedJobs,
  listNames,
  getName,
  upsertName,
  addMishearings,
  deleteName,
  updateName,
  upsertJobNameFixes,
};
