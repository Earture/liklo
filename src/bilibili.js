'use strict';
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { run, sleep } = require('./util');
const names = require('./names');

/* ---------------- cookies ---------------- */

/* Two formats are accepted, so anything a browser or devtools gives the user works:
 *  - Netscape cookies.txt (tab separated, optional `#HttpOnly_` prefix) — what
 *    "export cookies" produces. The expiry is column 4 in the classic layout and column 5
 *    in the file yt-dlp writes, so both are read.
 *  - a Cookie header copied from devtools (`name=value; name2=value2`)
 * Imports are rewritten in the layout yt-dlp itself writes, so the same file can be used
 * for downloads. */
function parseCookies(raw) {
  const entries = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l.startsWith('#') && !l.startsWith('#HttpOnly_'))) continue;
    const parts = l.split('\t');
    if (parts.length >= 6) {
      const expiry = parts.slice(3, parts.length - 2).find((p) => /^\d+$/.test(p.trim()));
      entries.push({
        domain: (parts[0] || '.bilibili.com').replace(/^#HttpOnly_/, ''),
        path: parts[2] || '/',
        expiration: Number(expiry) || 0,
        name: parts[parts.length - 2],
        value: parts[parts.length - 1] || '',
      });
    } else {
      for (const item of l.replace(/^#HttpOnly_/, '').split(';')) {
        const eq = item.indexOf('=');
        if (eq <= 0) continue;
        entries.push({
          domain: '.bilibili.com',
          path: '/',
          expiration: 0,
          name: item.slice(0, eq).trim(),
          value: item.slice(eq + 1).trim(),
        });
      }
    }
  }
  return entries.filter((e) => e.name && e.value);
}

function toNetscape(entries) {
  /* the header line is what makes http.cookiejar accept the file at all */
  return (
    '# Netscape HTTP Cookie File\n' +
    entries
      .map((e) => {
        const domain = e.domain || '.bilibili.com';
        // domain, includeSubDomains, path, secure, expiry, name, value — yt-dlp's order
        return [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', e.path || '/', 'FALSE', String(e.expiration || 0), e.name, e.value].join('\t');
      })
      .join('\n') + '\n'
  );
}

let fileJar = {}; // from the cookies.txt in use (imported or the default file)
let visitorJar = {}; // buvid3/buvid4 handed out by B站 itself, kept in memory
let jarIsStale = false; // B站 answered -101 with the file jar: stop sending it
let cookieInfo = null;

function loadCookies(force = false) {
  if (!force && cookieInfo) return fileJar;
  fileJar = {};
  cookieInfo = { file: config.COOKIE_FILE, exists: false, total: 0, expired: [], names: [] };
  let raw = '';
  try {
    raw = fs.readFileSync(config.COOKIE_FILE, 'utf8');
    cookieInfo.exists = true;
  } catch {
    /* no cookie file: unauthenticated requests still work for most endpoints */
  }
  const now = Math.floor(Date.now() / 1000);
  for (const e of parseCookies(raw)) {
    // an expired cookie is worse than no cookie: B站 answers -352 for a stale buvid
    if (e.expiration && e.expiration < now) {
      cookieInfo.expired.push(e.name);
      continue;
    }
    fileJar[e.name] = e.value;
  }
  cookieInfo.total = Object.keys(fileJar).length;
  cookieInfo.names = Object.keys(fileJar);
  jarIsStale = false;
  visitorCookie = null;
  invalidateWbi();
  seasonCache.clear();
  return fileJar;
}

function reloadCookies() {
  return loadCookies(true);
}

/** What the page shows: which file is in use, how many cookies, which ones are stale. */
function cookieStatus() {
  loadCookies();
  return {
    file: config.COOKIE_FILE,
    store: config.COOKIE_STORE,
    imported: config.COOKIE_FILE === config.COOKIE_STORE,
    exists: cookieInfo.exists,
    count: cookieInfo.total,
    names: cookieInfo.names,
    expired: cookieInfo.expired,
    hasBuvid: Boolean(fileJar.buvid3),
    hasLoginCookie: Boolean(fileJar.bili_jct),
    rejected: jarIsStale,
  };
}

function cookieHeader() {
  // a jar the server does not accept any more is dropped rather than sent again
  const jar = jarIsStale ? visitorJar : { ...fileJar, ...visitorJar };
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ---------------- http ---------------- */

let visitorCookie = null;

/* B站 risk control answers 412 / -352 to requests that carry no visitor id. The
 * finger/spi endpoint hands out buvid3/b_4 (the homepage sets them through JS, so
 * its Set-Cookie headers are usually empty); we keep them in the jar and retry. */
async function ensureVisitorCookies() {
  if (visitorJar.buvid3) return true;
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': config.UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json && json.data) {
      if (json.data.b_3) visitorJar.buvid3 = json.data.b_3;
      if (json.data.b_4) visitorJar.buvid4 = json.data.b_4;
    }
  } catch {
    /* fall through to the homepage */
  }
  try {
    const res = await fetch('https://www.bilibili.com/', {
      headers: { 'User-Agent': config.UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(15000),
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const item of raw) {
      const kv = String(item).split(';')[0];
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq).trim();
        if (k && !visitorJar[k]) visitorJar[k] = kv.slice(eq + 1).trim();
      }
    }
  } catch {
    /* risk control still applies; callers fall back to other sources */
  }
  visitorCookie = Boolean(visitorJar.buvid3);
  return visitorCookie;
}

function isRiskControl(res, json) {
  // 412/429/5xx and the risk-control codes (-352, -799) are all transient
  return res.status === 412 || res.status === 429 || res.status >= 500 || (json && (json.code === -352 || json.code === -799));
}

/* `opts.accept` lists codes that are a valid answer rather than a failure: nav answers
 * -101 to every anonymous client but still hands out the wbi keys in `data`. */
async function request(url, opts = {}) {
  const attempts = opts.retries === undefined ? 3 : opts.retries;
  const accepted = [0, ...(opts.accept || [])];
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': config.UA,
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        Accept: 'application/json, text/plain, */*',
        Cookie: cookieHeader(),
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok || (json && !accepted.includes(json.code))) {
      /* -101 means "not logged in": the cookies in the jar are no longer accepted.
       * Most of these endpoints work anonymously, so drop the imported jar and retry with
       * only the visitor id instead of failing every discovery call. */
      if (json && json.code === -101 && !accepted.includes(-101) && !jarIsStale && attempt < attempts) {
        jarIsStale = true;
        await ensureVisitorCookies();
        if (/wbi|search\/type/.test(url)) invalidateWbi();
        await sleep(1000);
        continue;
      }
      if (isRiskControl(res, json) && attempt < attempts) {
        await ensureVisitorCookies();
        if (/wbi|search\/type/.test(url)) invalidateWbi();
        await sleep(2000 * (attempt + 1) + Math.floor(Math.random() * 1500));
        continue;
      }
      throw new Error(`HTTP ${res.status} ${url} ${json ? 'code=' + json.code + ' ' + (json.message || '') : text.slice(0, 200)}`);
    }
    return json ?? { code: -1, message: 'non-json response', raw: text.slice(0, 200) };
  }
  throw new Error(`request failed: ${url}`);
}

/* ---------------- parsing helpers ---------------- */

function extractBvid(url) {
  const m = String(url).match(/BV[a-zA-Z0-9]{10,12}/);
  if (m) return m[0];
  const av = String(url).match(/av(\d+)/i);
  return av ? 'av' + av[1] : null;
}

/** Resolve a UP's mid from a space URL, a bare mid, or a video URL. */
function extractMid(urlOrMid) {
  const s = String(urlOrMid || '');
  const space = s.match(/space\.bilibili\.com\/(\d+)/);
  if (space) return space[1];
  const bare = s.trim().match(/^\d+$/);
  return bare ? bare[0] : null;
}

/** Best-effort UP display name: metadata of one of their videos. */
async function getOwnerName(mid) {
  const list = await listSpaceVideos(mid, 1);
  if (!list.length) return null;
  const info = await getVideoInfoCached(list[0].bvid);
  return info.owner || null;
}

/** Video metadata via the public view API (title, owner, duration, pages). */
async function getVideoInfo(urlOrBvid) {
  const bvid = extractBvid(urlOrBvid) || String(urlOrBvid);
  const j = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const d = j.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    url: `https://www.bilibili.com/video/${d.bvid}`,
    owner: d.owner?.name || '',
    mid: d.owner?.mid || null,
    duration: d.duration || 0,
    pubdate: d.pubdate || 0,
    pages: d.pages || [1],
    parts: (d.pages || []).map((p, i) => ({ page: i + 1, title: p.part || `p${i + 1}`, duration: p.duration || 0 })),
  };
}

/** List a UP's uploaded videos (newest first) using yt-dlp's BilibiliSpaceVideo extractor. */
async function listSpaceVideos(mid, max = 30) {
  const args = [
    '--flat-playlist', '-J',
    '--playlist-items', `1-${max}`,
    `https://space.bilibili.com/${mid}/upload/video`,
  ];
  if (fs.existsSync(config.COOKIE_FILE)) args.push('--cookies', config.COOKIE_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await run(config.YTDLP, args, { timeout: 120000 });
      const playlist = JSON.parse(stdout);
      const videos = [];
      for (const entry of playlist.entries || []) {
        if (entry.ie_key !== 'BiliBili') continue; // skip collections/playlists
        const bvid = entry.id;
        if (!/^BV[a-zA-Z0-9]{10,12}$/.test(bvid)) continue;
        videos.push({ bvid, url: entry.url || `https://www.bilibili.com/video/${bvid}`, title: entry.title || '' });
      }
      return videos;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(4000 * (attempt + 1));
    }
  }
}

/* ---------------- native space listing (B站 JSON APIs, no yt-dlp) ----------------
 *
 * yt-dlp's space extractor pages through *every* upload of a channel, which takes
 * minutes and is what made 「检查新录播」 time out. B站's own space API returns
 * collections and their newest entries (title, pubdate, duration included) in a
 * few hundred ms, so discovery uses it and yt-dlp is only a fallback.
 */

const seasonCache = new Map(); // mid -> { at, seasons }
const SEASON_CACHE_TTL_MS = 6 * 3600 * 1000;

/* ---------------- search API (WBI-signed) ----------------
 *
 * The home-page 合集 endpoint only returns a handful of collections, so a
 * channel with many collections (e.g. one per VTuber) cannot be enumerated
 * through it. B站's search API is one signed request and returns the newest
 * uploads matching a keyword with title/pubdate/duration, so it is used as a
 * second native source of candidates.
 */

let wbiKeys = null;
let wbiKeysAt = 0;
const WBI_TTL_MS = 30 * 60 * 1000; // keys rotate; a stale signature is what makes search 412

function invalidateWbi() {
  wbiKeys = null;
}

async function getWbiKeys(force = false) {
  if (wbiKeys && !force && Date.now() - wbiKeysAt < WBI_TTL_MS) return wbiKeys;
  // nav replies -101 for clients that are not logged in, but the wbi keys are in the
  // body anyway, so that answer is good enough here
  const nav = await request('https://api.bilibili.com/x/web-interface/nav', { retries: 2, accept: [-101] });
  if (!nav.data || !nav.data.wbi_img) throw new Error('no wbi keys in nav response');
  const cut = (u) => String(u).slice(String(u).lastIndexOf('/')).split('.')[0];
  wbiKeys = {
    imgKey: cut(nav.data.wbi_img.img_url),
    subKey: cut(nav.data.wbi_img.sub_url),
  };
  wbiKeysAt = Date.now();
  return wbiKeys;
}

function wbiSign(params, imgKey, subKey) {
  const raw = imgKey + subKey;
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return { ...params, w_rid: crypto.createHash('md5').update(query + raw).digest('hex') };
}

function parseDuration(text) {
  const parts = String(text || '').split(':').map((n) => parseInt(n, 10) || 0);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Newest videos of a UP whose title matches `keyword`, via the search API. */
async function searchUserVideos(mid, keyword, limit = 10) {
  const { imgKey, subKey } = await getWbiKeys();
  const params = wbiSign(
    {
      search_type: 'video',
      keyword: String(keyword || ''),
      order: 'pubdate',
      page: 1,
      pageSize: Math.min(20, Math.max(5, limit * 2)),
    },
    imgKey,
    subKey
  );
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const j = await request(`https://api.bilibili.com/x/web-interface/search/type?${qs}`, { retries: 3 });
  const results = (j.data && j.data.result) || [];
  return results
    .filter((r) => String(r.mid) === String(mid))
    .map((r) => ({
      bvid: r.bvid,
      url: `https://www.bilibili.com/video/${r.bvid}`,
      title: String(r.title || '').replace(/<[^>]+>/g, ''),
      pubdate: r.pubdate || 0,
      duration: parseDuration(r.duration),
    }));
}

/** Newest uploads of a UP straight from the space upload API (WBI-signed).
 *
 * This is the only native endpoint that lists *all* uploads newest-first, so it
 * is used when a channel keeps its replays outside 合集. It is risk-controlled
 * (-352) for anonymous clients, hence the visitor-cookie bootstrap in request().
 */
async function listSpaceUploadsNative(mid, max = 20) {
  const { imgKey, subKey } = await getWbiKeys();
  const params = wbiSign(
    {
      mid: Number(mid),
      offset: 0,
      limit: Math.min(30, Math.max(5, max)),
      order: 'pubdate',
      pubtime_filter: 0,
      platform: 'web',
      video_source: 0,
      category: 0,
      show_type: 0,
    },
    imgKey,
    subKey
  );
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const j = await request(`https://api.bilibili.com/x/space/wbi/arc/search?${qs}`, { retries: 3 });
  const rows = ((j.data && j.data.page && j.data.page.data) || []).map((v) => ({
    bvid: v.bvid,
    url: `https://www.bilibili.com/video/${v.bvid}`,
    title: String(v.title || ''),
    pubdate: v.publish_time || v.ctime || 0,
    duration: Number(v.duration) || 0,
  }));
  if (!rows.length) throw new Error('empty upload list');
  return rows;
}

/** List a UP's 合集 (seasons). Cached, since season ids change rarely. */
async function listSeasons(mid) {
  const key = String(mid);
  const hit = seasonCache.get(key);
  if (hit && Date.now() - hit.at < SEASON_CACHE_TTL_MS) return hit.seasons;
  const seasons = [];
  for (let page = 1; page <= 5; page++) {
    const j = await request(
      `https://api.bilibili.com/x/polymer/web-space/home/seasons_series?mid=${encodeURIComponent(mid)}&page_num=${page}&page_size=20`,
      { retries: 2 }
    );
    const lists = (j.data && j.data.items_lists) || {};
    const items = lists.seasons_list || [];
    for (const s of items) {
      const meta = s.meta || {};
      const id = meta.season_id || s.id;
      if (!id) continue;
      seasons.push({
        seasonId: String(id),
        title: meta.name || meta.title || s.title || '',
        total: meta.total || (s.archives ? s.archives.length : 0),
      });
    }
    const pages = (lists.page && lists.page.total) || 1;
    if (!items.length || page >= pages) break;
  }
  seasonCache.set(key, { at: Date.now(), seasons });
  return seasons;
}

/** Newest `max` entries of a season, newest first.
 *
 * B站 lists a season oldest-first, so the newest entries are on the last page.
 * The response already carries title/pubdate/duration, so candidates can be
 * filtered without any per-video metadata request.
 */
async function listSeasonArchives(mid, seasonId, max = 8) {
  const first = await request(
    `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(seasonId)}&page_num=1&page_size=1`,
    { retries: 2 }
  );
  const total = (first.data && first.data.page && first.data.page.total) || 0;
  if (!total) return [];
  const pageSize = Math.max(1, Math.min(20, max));
  const lastPage = Math.ceil(total / pageSize);
  const j = await request(
    `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(seasonId)}&page_num=${lastPage}&page_size=${pageSize}`,
    { retries: 2 }
  );
  const archives = ((j.data && j.data.archives) || [])
    .slice()
    .sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0));
  return archives.slice(0, max).map((a) => ({
    bvid: a.bvid,
    url: `https://www.bilibili.com/video/${a.bvid}`,
    title: a.title || '',
    pubdate: a.pubdate || 0,
    duration: a.duration || 0,
  }));
}

/* ---------------- collection resolution ----------------
 *
 * The home-page 合集 endpoint advertises only a few collections, so a channel that
 * keeps its replays in a collection it does not advertise (e.g. 「莉蔻Liko直播录像」
 * on a multi-UP channel) is invisible to discovery: seasons_series returns the other
 * collections and the upload tab is risk-controlled.
 *
 * Every video page carries the id and title of the collection it belongs to, so one
 * candidate we already found is enough to open the whole collection and read its
 * newest entries. Cached per bvid, so a discovery pass fetches at most a few pages.
 */
const collectionCache = new Map(); // bvid -> { seasonId, title } | null

async function resolveCollection(bvidOrUrl) {
  const bvid = extractBvid(bvidOrUrl);
  if (!bvid) return null;
  const key = String(bvid);
  if (collectionCache.has(key)) return collectionCache.get(key);
  let result = null;
  try {
    const res = await fetch(`https://www.bilibili.com/video/${bvid}`, {
      headers: {
        'User-Agent': config.UA,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.bilibili.com/',
      },
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();
    const link = html.match(/collectiondetail\?sid=(\d+)/);
    if (link) result = { seasonId: link[1], title: (html.match(/collectiondetail\?sid=\d+[^>]*title="([^"]+)"/) || [])[1] || '' };
  } catch (e) {
    console.error(`[bilibili] collection lookup failed for ${bvid}: ${e.message.slice(0, 120)}`);
  }
  collectionCache.set(key, result);
  return result;
}

/** List a UP's 合集 (season/collection) pages from the upload tab (yt-dlp fallback).
 *
 * Many channels post live replays only inside per-streamer collections, and
 * yt-dlp's upload-tab playlist does not contain those videos, so the upload tab
 * alone is not enough to discover new replays.
 */
async function listSpaceCollections(mid) {
  const args = ['--flat-playlist', '-J', `https://space.bilibili.com/${mid}/upload/video`];
  if (fs.existsSync(config.COOKIE_FILE)) args.push('--cookies', config.COOKIE_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await run(config.YTDLP, args, { timeout: 120000 });
      const playlist = JSON.parse(stdout);
      const out = [];
      for (const entry of playlist.entries || []) {
        if (entry.ie_key !== 'BilibiliCollectionList') continue;
        const m = String(entry.id).match(/_(\d+)$/);
        if (!m) continue;
        out.push({ seasonId: m[1], title: entry.title || '', url: entry.url });
      }
      return out;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(4000 * (attempt + 1));
    }
  }
}

/** Newest `max` bvids of a collection (yt-dlp lists collections oldest first). */
async function listCollectionVideos(mid, seasonId, max = 8) {
  const args = [
    '--flat-playlist', '-J',
    '--playlist-items', `-${Math.max(1, max)}--1`,
    `https://space.bilibili.com/${mid}/lists/${seasonId}?type=season`,
  ];
  if (fs.existsSync(config.COOKIE_FILE)) args.push('--cookies', config.COOKIE_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await run(config.YTDLP, args, { timeout: 120000 });
      const playlist = JSON.parse(stdout);
      const videos = [];
      for (const entry of (playlist.entries || []).reverse()) {
        const bvid = entry.id;
        if (!/^BV[a-zA-Z0-9]{10,12}$/.test(bvid)) continue;
        videos.push({ bvid, url: entry.url || `https://www.bilibili.com/video/${bvid}`, title: entry.title || '' });
      }
      return videos;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(4000 * (attempt + 1));
    }
  }
}

/** Metadata cache so repeated monitor passes do not re-hit the view API. */
const metaCache = new Map(); // bvid -> { at, info }
const META_CACHE_TTL_MS = 15 * 60 * 1000;

async function getVideoInfoCached(urlOrBvid) {
  const bvid = extractBvid(urlOrBvid);
  if (!bvid) return getVideoInfo(urlOrBvid);
  const hit = metaCache.get(bvid);
  if (hit && Date.now() - hit.at < META_CACHE_TTL_MS) return hit.info;
  const info = await getVideoInfo(bvid);
  metaCache.set(bvid, { at: Date.now(), info });
  return info;
}

/* ---------------- what counts as a 录播 ----------------
 *
 * Channels title replays in every style: 「…直播回放」, 「…（2026.10.19_2131）」,
 * 「…直播录像」, or a plain stream title inside a collection named 「直播回放」.
 * A hard keyword gate therefore misses most of them, so recognition is a score:
 * an explicit keyword, a broadcast date on a stream-length video, or a
 * 直播/回放/录播 collection title all count.
 */
const REPLAY_CONTEXT_RE = /(直播|录播|回放|录像|replay|live)/i;
const DATE_RE =
  /(20\d{2}[-._/]\d{1,2}[-._/]\d{1,2})|(\d{2}\.\d{1,2}\.\d{1,2})|(20\d{2}[-._]\d{4})|(\d{4}[-._]\d{4})/;
const MIN_REPLAY_SECONDS = Number(config.MIN_REPLAY_SECONDS || 1200); // 20 min: shorter uploads are clips, not streams

/** Is this upload a live replay? `context` is the collection title it came from.
 *
 * A keyword or a 直播 collection name is not enough on its own: 「稍微播一下鼠」
 * clips from a stream are uploaded into the same 合集 and are not 录播. Anything
 * shorter than MIN_REPLAY_SECONDS is a clip no matter how it is titled. Unknown
 * duration (some search results do not report one) is not treated as short.
 */
function isReplay(title, keywords, duration = 0, context = '') {
  const t = String(title || '').toLowerCase();
  const c = String(context || '').toLowerCase();
  if (duration > 0 && duration < MIN_REPLAY_SECONDS) return false;
  const kws = (keywords || '').split(/[,，;；\s]+/).filter(Boolean);
  if (kws.some((k) => t.includes(k.toLowerCase()) || c.includes(k.toLowerCase()))) return true;
  if (DATE_RE.test(String(title))) return true;
  if (REPLAY_CONTEXT_RE.test(c)) return true;
  return false;
}

function parseTerms(match) {
  return String(match || '').split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
}

/** Optional per-streamer filter: title must contain one of the match terms. */
function matchesName(title, match) {
  const terms = parseTerms(match);
  if (!terms.length) return true;
  const t = String(title || '').toLowerCase();
  return terms.some((term) => t.includes(term.toLowerCase()));
}

/** Which terms decide "this upload belongs to the streamer I added"?
 *
 * An explicit 「匹配关键词」 always wins. When none is configured we fall back to
 * the streamer's own name / romanised name: one B站 account can host several
 * people (e.g. a channel whose 合集 are 「酸柚粥sayo」, 「花礼Harei」, 「夜澄シロShiro」),
 * and without a filter every persona's 录播 is treated as this streamer's.
 *
 * The fallback is only applied when it actually discriminates. If not a single
 * candidate title contains the name, the channel simply does not put the name in
 * titles, and filtering by it would drop everything — so it is skipped.
 */
function nameFilter(match, streamer) {
  const explicit = parseTerms(match);
  if (explicit.length) return { terms: explicit, implicit: false };
  return {
    terms: parseTerms([streamer && streamer.name, streamer && streamer.english].join(',')),
    implicit: true,
  };
}

/**
 * Which person a replay actually belongs to.
 *
 * A channel that hosts several VTubers names the person in the title
 * ("莉蔻Liko  中午好呀~") and in the 合集 title ("莉蔻Liko直播录像"). When no
 * 「匹配关键词」 is configured the name filter decides nothing (see nameFilter),
 * so without this the job would be labelled with the UP display name
 * ("牧场草原神official") even though someone else is streaming.
 *
 * A name that appears in both the title and the collection it came from is the
 * strongest signal; otherwise the collection's persona wins over a title that
 * only names a guest. Returns null when neither mentions a person.
 */
function detectPersona(title, context = '') {
  const inTitle = names.extractNames(title);
  const inContext = names.extractNames(context);
  return (
    inTitle.find((n) => inContext.some((c) => c.name === n.name)) ||
    inContext[0] ||
    inTitle[0] ||
    null
  );
}

/** Search keywords for a UP: the configured match terms, or the display name /
 * romanised name when none are configured. 「term 直播回放」 and 「term 直播录像」
 * are what B站 actually ranks newest replays highest — the bare name usually only
 * returns the newest upload. */
function buildSearchQueries(match, keywords, streamer) {
  let terms = String(match || '').split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!terms.length) terms = [streamer && streamer.name, streamer && streamer.english].filter(Boolean);
  const queries = [];
  const push = (q) => {
    const s = String(q || '').trim();
    if (s && !queries.includes(s)) queries.push(s);
  };
  for (const term of terms.slice(0, 2)) {
    push(term);
    push(`${term} 直播回放`);
    push(`${term} 直播录像`);
    push(`${term} 录像`);
    push(`${term} 录播`);
  }
  return queries.slice(0, 8);
}

/** Find the newest replay in a UP's collections/uploads that is not already processed.
 *
 * Candidate sources, in order:
 *   1. every relevant 合集 (season) on the space page — newest tail entries, via B站's API
 *   2. the search API scoped to this UP and the streamer name — catches collections
 *      the home-page endpoint does not list
 *   3. the upload tab, via the native space API, then yt-dlp — last resort
 *
 * Returns { replays, stats } so the caller can show *why* nothing was found.
 */
async function findNewReplays(mid, keywords, excludeBvids, limit = 1, match = '', candidateLimit = 20, collectionTail = 8, streamer = null) {
  const pool = [];
  const seen = new Set();
  const stats = {
    mid: String(mid),
    name: (streamer && streamer.name) || '',
    seasons: 0,
    seasonsChecked: 0,
    queries: [],
    collections: [],
    candidates: 0,
    accepted: 0,
    rejected: { known: 0, notReplay: 0, nameFilter: 0, duplicate: 0, badId: 0 },
    sources: [],
    filter: null,
    error: null,
  };
  const collect = (v, context = '') => {
    const bvid = v.bvid;
    stats.candidates += 1;
    if (!/^BV[a-zA-Z0-9]{10,12}$/.test(bvid)) {
      stats.rejected.badId += 1;
      return;
    }
    if (seen.has(bvid)) {
      stats.rejected.duplicate += 1;
      return;
    }
    seen.add(bvid);
    if (excludeBvids.has(bvid)) {
      stats.rejected.known += 1;
      return;
    }
    if (!isReplay(v.title, keywords, v.duration || 0, context)) {
      stats.rejected.notReplay += 1;
      return;
    }
    pool.push({ v, context });
  };

  let seasons = [];
  try {
    seasons = await listSeasons(mid);
    stats.seasons = seasons.length;
  } catch (e) {
    stats.error = e.message;
    console.error(`[bilibili] season listing failed for mid=${mid}: ${e.message.slice(0, 120)}`);
  }

  // Only collections that can plausibly hold this streamer's replays are opened;
  // a channel with 11 collections otherwise costs 22 requests per pass.
  const filter = nameFilter(match, streamer);
  const nameTerms = filter.terms.map((t) => t.toLowerCase());
  const relevant = seasons.filter(
    (s) => nameTerms.some((t) => String(s.title || '').toLowerCase().includes(t)) || REPLAY_CONTEXT_RE.test(s.title || '')
  );
  const toCheck = relevant.length ? relevant : seasons.slice(0, Number(config.MONITOR_MAX_SEASONS || 6));
  const opened = new Set();
  for (const s of toCheck) {
    opened.add(String(s.seasonId));
    try {
      stats.sources.push(`season:${s.title || s.seasonId}`);
      for (const v of await listSeasonArchives(mid, s.seasonId, collectionTail)) collect(v, s.title);
      stats.seasonsChecked += 1;
    } catch (e) {
      console.error(`[bilibili] season ${s.seasonId} listing failed: ${e.message.slice(0, 120)}`);
    }
  }

  // Search covers collections the home-page endpoint does not expose.
  const queries = buildSearchQueries(match, keywords, streamer);
  stats.queries = queries;
  for (const q of queries) {
    if (pool.length >= candidateLimit) break;
    try {
      stats.sources.push(`search:${q}`);
      for (const v of await searchUserVideos(mid, q, collectionTail)) collect(v, q);
    } catch (e) {
      console.error(`[bilibili] search failed for mid=${mid} kw=${q}: ${e.message.slice(0, 120)}`);
    }
    await sleep(400);
  }

  /** Open collections that seasons_series never advertised.
   *
   * Any candidate we already have names the collection it belongs to, so one hit is
   * enough to enumerate that collection's newest entries. This is the only way to
   * see replays on channels whose 合集 is not on the space home page.
   */
  const discoverCollections = async () => {
    // Seed from the candidates that actually belong to the streamer we are looking
    // for: that is the collection the space home page hides.
    const seeds = pool
      .filter((p) => !filter.terms.length || matchesName(p.v.title, filter.terms.join(',')))
      .concat(pool)
      .slice(0, 4);
    for (const seed of seeds) {
      const col = await resolveCollection(seed.v.bvid);
      if (!col || opened.has(String(col.seasonId))) continue;
      opened.add(String(col.seasonId));
      stats.sources.push(`collection:${col.title || col.seasonId}`);
      stats.collections.push({ seasonId: col.seasonId, title: col.title || '' });
      try {
        for (const v of await listSeasonArchives(mid, col.seasonId, collectionTail)) collect(v, col.title);
        stats.seasonsChecked += 1;
      } catch (e) {
        console.error(`[bilibili] collection ${col.seasonId} listing failed: ${e.message.slice(0, 120)}`);
      }
    }
  };

  await discoverCollections();

  // Fallback for channels whose replays are not inside a 合集 (or if the APIs
  // listed nothing that qualified — an empty candidate set is not evidence that
  // there is nothing new, only that the sources we tried had nothing).
  const gatherUploads = async () => {
    let rows = [];
    try {
      stats.sources.push('space:wbi/arc');
      rows = await listSpaceUploadsNative(mid, candidateLimit);
    } catch (e) {
      console.error(`[bilibili] native upload listing failed for mid=${mid}: ${e.message.slice(0, 120)}`);
    }
    if (!rows.length) {
      try {
        stats.sources.push('yt-dlp:space');
        rows = await listSpaceVideos(mid, candidateLimit);
        // Only resolve metadata for uploads that can be the streamer we are
        // looking for; a flat playlist gives titles, and fetching 20 video pages
        // per pass is not worth it when 19 of them belong to someone else. A flat
        // space playlist can come back with empty titles, so those entries are kept
        // and resolved through the view API instead of being dropped.
        const wanted = filter.terms.length ? rows.filter((v) => !v.title || matchesName(v.title, filter.terms.join(','))) : rows;
        for (const v of wanted) {
          try {
            collect(await getVideoInfoCached(v.bvid));
          } catch (e) {
            console.error(`[bilibili] metadata failed for ${v.bvid}: ${e.message.slice(0, 120)}`);
          }
          await sleep(300);
        }
      } catch (e) {
        console.error(`[bilibili] upload listing failed for mid=${mid}: ${e.message.slice(0, 120)}`);
      }
    } else {
      for (const v of rows) collect(v);
    }
  };

  // Decide the name filter last, so we can tell whether it is meaningful: an
  // implicit filter built from the streamer name is dropped if nothing in the
  // candidate set carries it (that channel just does not name its uploads). An
  // explicit 「匹配关键词」 is honoured even when it matches nothing — the user
  // asked for one person, and a channel that hosts several people must not have
  // the other people's 录播 queued because that person happened to be quiet today.
  const terms = filter.terms;
  const countHits = () => (terms.length ? pool.filter((p) => matchesName(p.v.title, terms.join(','))).length : 0);
  let hits = countHits();
  // Nothing we collected belongs to this streamer: the collections we opened are
  // not theirs, so list the uploads directly before concluding there is nothing.
  if (!pool.length || (terms.length && hits === 0)) {
    await gatherUploads();
    // The upload tab may have produced the first hit; use it to open the collection
    // that the space home page does not list.
    await discoverCollections();
    hits = countHits();
  }
  const active = terms.length && (hits > 0 || !filter.implicit) ? terms : [];
  stats.filter = active.length ? active.join(', ') : 'none';
  if (filter.implicit && terms.length && hits === 0) stats.filter = 'none (name filter skipped: no title contains the streamer name)';

  const found = [];
  for (const p of pool) {
    if (active.length && !matchesName(p.v.title, active.join(','))) {
      stats.rejected.nameFilter += 1;
      continue;
    }
    const v = p.v;
    found.push({
      bvid: v.bvid,
      url: v.url || `https://www.bilibili.com/video/${v.bvid}`,
      title: v.title || '',
      pubdate: v.pubdate || 0,
      duration: v.duration || 0,
      mid: String(mid),
      // the person this upload is about; null when nothing in the title or the
      // collection names one, in which case the streamer entry is used as-is
      persona: detectPersona(v.title, p.context),
    });
    stats.accepted += 1;
  }

  found.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0));
  console.log(
    `[bilibili] mid=${mid} candidates=${stats.candidates} accepted=${stats.accepted} ` +
      `rejected=${JSON.stringify(stats.rejected)} filter=${stats.filter} sources=${stats.sources.length}`
  );
  return { replays: found.slice(0, limit), stats };
}

/** Try the endpoints discovery actually needs, with the cookies currently in the jar,
 * so importing a cookies.txt can be checked instead of guessed at. */
async function probeCookies(mid) {
  const checks = [];
  const check = async (label, fn) => {
    try {
      checks.push({ label, ok: true, detail: await fn() });
    } catch (e) {
      checks.push({ label, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  };
  await check('登录状态 /x/web-interface/nav', async () => {
    const j = await request('https://api.bilibili.com/x/web-interface/nav', { retries: 1, accept: [-101] });
    return { isLogin: Boolean(j.data && j.data.isLogin), name: (j.data && j.data.name) || '' };
  });
  await check('合集列表 seasons_series', async () => ({ seasons: (await listSeasons(mid)).length }));
  await check('上传列表 wbi/arc/search', async () => ({ videos: (await listSpaceUploadsNative(mid, 5)).length }));
  await check('搜索 search/type', async () => ({ results: (await searchUserVideos(mid, '直播', 5)).length }));
  return { mid, cookie: cookieStatus(), checks };
}

module.exports = {
  request,
  wbiSign,
  getWbiKeys,
  parseCookies,
  toNetscape,
  cookieStatus,
  reloadCookies,
  probeCookies,
  extractBvid,
  extractMid,
  getOwnerName,
  getVideoInfo,
  getVideoInfoCached,
  listSpaceVideos,
  listSpaceUploadsNative,
  searchUserVideos,
  listSeasons,
  listSeasonArchives,
  resolveCollection,
  listSpaceCollections,
  listCollectionVideos,
  isReplay,
  matchesName,
  detectPersona,
  buildSearchQueries,
  findNewReplays,
  loadCookies,
};
