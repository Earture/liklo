'use strict';
const config = require('./config');
const db = require('./db');
const bilibili = require('./bilibili');
const pipeline = require('./pipeline');

let timer = null;
let running = false;

// Progress of the last/ongoing discovery pass, exposed through
// GET /api/monitor/status so the UI can poll instead of waiting on one
// long-running request.
let status = {
  running: false,
  startedAt: null,
  finishedAt: null,
  checked: 0,
  total: 0,
  created: 0,
  found: [],
  error: null,
  progress: '尚未检查',
  // per-UP diagnostics: how many candidates were seen and why they were skipped,
  // so "没有新的录播" is explainable instead of a black box
  per: [],
};

async function checkStreamers(opts = {}) {
  if (running) {
    // A pass is already in flight (interval + button can collide); do not
    // start a second one, which would just hammer B站 with duplicate listing.
    return status.created;
  }
  running = true;
  status = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    checked: 0,
    total: 0,
    created: 0,
    found: [],
    error: null,
    progress: '正在读取 B站 合集列表…',
    per: [],
  };
  try {
    const streamers = db.listStreamers().filter((s) => s.monitor);
    status.total = streamers.length;
    if (!streamers.length) {
      status.progress = '没有开启实时监控的主播';
      return 0;
    }
    // opts.rediscover lets cancelled jobs be found again (e.g. a cancelled job
    // whose download failed and the user wants it retried automatically).
    const known = db.knownBvids({ excludeCancelled: !!opts.rediscover });
    for (const s of streamers) {
      status.progress = `检查 ${s.name}（第 ${status.checked + 1}/${status.total} 个 UP）…`;
      const diag = { mid: String(s.mid), name: s.name, created: 0, error: null };
      try {
        const { replays, stats } = await bilibili.findNewReplays(
          s.mid,
          s.keywords,
          known,
          config.MONITOR_LIMIT,
          s.match,
          20,
          8,
          s
        );
        Object.assign(diag, {
          candidates: stats.candidates,
          accepted: stats.accepted,
          rejected: stats.rejected,
          seasons: stats.seasons,
          seasonsChecked: stats.seasonsChecked,
          collections: stats.collections || [],
          queries: stats.queries,
          sources: stats.sources,
          filter: stats.filter,
        });
        for (const info of replays) {
          // The UP display name is not the person who streamed: a channel with
          // several VTubers names each stream in its title/合集. Label the job with
          // that person when we can identify one, so the report, the name table and
          // the report page all attribute the stream to the right person.
          const persona = info.persona;
          const streamer = persona
            ? { ...s, name: persona.name, english: persona.english || s.english }
            : s;
          const job = await pipeline.createJob(info.url, { auto: 1, streamer });
          known.add(info.bvid);
          status.created += 1;
          diag.created += 1;
          status.found.push({ id: job.id, bvid: info.bvid, title: info.title, streamer: streamer.name });
          console.log(`[monitor] new replay for ${streamer.name}: ${info.title} (${info.bvid})`);
        }
        if (!replays.length) {
          const why = [
            `${stats.candidates} 条候选`,
            `${stats.rejected.notReplay} 条不像直播`,
            `${stats.rejected.known} 条已处理`,
            stats.rejected.nameFilter ? `${stats.rejected.nameFilter} 条标题不含「${stats.filter}」` : '',
          ].filter(Boolean).join('，');
          status.progress = `${s.name}: 没有新的录播（${why}）`;
        }
        const stmt = db.db.prepare("UPDATE streamers SET last_check_at = datetime('now') WHERE mid = ?");
        stmt.run(String(s.mid));
      } catch (e) {
        console.error(`[monitor] failed for mid=${s.mid}:`, e.message);
        status.error = e.message;
        diag.error = e.message;
        status.progress = `${s.name}: 检查失败（${e.message.slice(0, 80)}）`;
      }
      status.per.push(diag);
      status.checked += 1;
    }
  } finally {
    running = false;
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
  return status.created;
}

/** Start a pass without waiting for it, so the browser never hangs on one request. */
function runNow(opts = {}) {
  checkStreamers(opts).catch((e) => {
    console.error('[monitor] error:', e.message);
    status.error = e.message;
    status.running = false;
    status.finishedAt = new Date().toISOString();
  });
  return status;
}

function getStatus() {
  return status;
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    checkStreamers().catch((e) => console.error('[monitor] error:', e.message));
  }, config.MONITOR_INTERVAL_MS);
  console.log(`[monitor] checking monitored UPs every ${config.MONITOR_INTERVAL_MS / 60000} min`);
  // first check soon after startup
  setTimeout(() => checkStreamers().catch((e) => console.error('[monitor] error:', e.message)), 5000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { checkStreamers, runNow, getStatus, start, stop };
