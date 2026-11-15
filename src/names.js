'use strict';

/**
 * Name correction.
 *
 * ASR (moss-transcribe) regularly writes person names as phonetically similar
 * wrong words: 克朗 / 克尔 / 克里亚 -> 克罗雅, 鼠姐 -> 薯姐. The user maintains a
 * name table (src/db.js `names`), and names found in video titles / streamer
 * entries are added to it automatically.
 *
 * Two steps, deliberately split:
 *  1. deterministic near-miss scan: every CJK/latin run in the text within edit
 *     distance <= 2 of a known name form becomes a *candidate*. No LLM, no cost.
 *  2. one bounded LLM call: given the name table, the candidates and their
 *     context, the model says which candidates are really misheard names. Code
 *     then applies the replacements itself (string replace), so the report and
 *     transcript can never be silently rewritten by the model.
 *
 * `correct` must resolve to a name table entry, otherwise the fix is dropped.
 * Applying fixes is idempotent: a second run finds nothing left to fix.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { chat } = require('./report');
const { NAME_STOPWORDS, transcriptPathFor, rawTranscriptPathFor } = require('./util');

const MAX_CANDIDATES = Number(process.env.NAME_MAX_CANDIDATES || '20');
// One call per run when possible. The model confirms candidates far more reliably
// when it sees the whole set at once: a batch of eight near-misses of one name reads
// as "the transcript is fine, these are ordinary words" and returns [], while the
// same candidates inside the full list are recognised. Only very long candidate sets
// are split, and a split is retried as halves.
const CANDIDATE_BATCH = Number(process.env.NAME_CANDIDATE_BATCH || '24');
// Confirming candidates is a small extraction task, so these calls are deliberately
// kept cheap: no reasoning (the model's thinking otherwise eats the whole completion
// budget, the JSON comes back empty, and every batch is retried as halves), a short
// output limit, and a per-call timeout far shorter than the one used for report
// generation. Without a phase budget a slow model could hold a job at this step for
// tens of minutes and the pipeline looked stuck at the name scan.
const CALL_TIMEOUT_MS = Number(process.env.NAME_CALL_TIMEOUT_MS || '90000');
const PHASE_BUDGET_MS = Number(process.env.NAME_TIME_BUDGET_MS || '180000');
const MAX_SPLIT_DEPTH = Number(process.env.NAME_SPLIT_DEPTH || '1');
const CONTEXTS_PER_CANDIDATE = 2;
const CONTEXT_CHARS = 60;
// The whole transcript is scanned: a fixed window used to cut the tail of a long
// replay off, so names that only appear in the last hour were never found.
// `NAME_MAX_SCAN_CHARS` is only a safety valve for pathological inputs (0 = no limit).
const MAX_SCAN_CHARS = Number(process.env.NAME_MAX_SCAN_CHARS || '0');
// A 4 hour replay contains more people and more distinct mishearings than a 1 hour
// one, so the number of candidates handed to the LLM grows with the text scanned
// instead of being a flat cap. Bounded so the confirmation calls stay finite.
const CANDIDATE_CAP_MAX = Number(process.env.NAME_CANDIDATE_CAP_MAX || '60');
const CANDIDATE_CAP_STEP = Number(process.env.NAME_CANDIDATE_CAP_STEP || '4'); // extra candidates per 20k chars
// A member the ASR writes as something completely unrelated to the table spelling
// ("妮可" for 莉蔻Liko) is invisible to both the edit-distance scan and the
// sound-based lookup: no character, no syllable in common. Such a substitution is
// only detectable from how it is *used* — it recurs where a name belongs. These
// tokens are handed to the model as unknown spellings; a confirmed mapping is
// written into the name table, so the next replay finds it deterministically.
const UNKNOWN_MIN_COUNT = Number(process.env.NAME_UNKNOWN_MIN_COUNT || '3');
const UNKNOWN_MAX = Number(process.env.NAME_UNKNOWN_MAX || '8');

// ordinary words the edit-distance scan keeps hitting; they are never names.
// The multi-character entries are the ones that *contain* a name fragment: "克风"
// is 麦+克风 inside 麦克风, "羽绒" is 羽绒服, "小浣" is 小浣熊. Listing them lets
// isProseContext reject the fragment as soon as it sees the real word around it.
const COMMON_WORDS = new Set([
  '哎呀', '真的', '什么', '这个', '那个', '我们', '你们', '他们', '大家', '时候',
  '东西', '好像', '感觉', '自己', '没事', '好的', '是的', '不是', '可以', '这样',
  '那么', '怎么', '因为', '所以', '但是', '不过', '已经', '现在', '今天', '明天',
  '有人', '没人', '别人', '一些', '没有', '不会', '就是', '还有', '知道', '觉得',
  '开始', '结束', '直播', '录像', '弹幕', '粉丝', '观众', '游戏', '姐姐',
  '哥哥', '弟弟', '妹妹', '老师', '朋友', '同学', '名字', '叫作', '叫做', '她说',
  '他说', '我说', '你说', '咱们', '小时', '上海', '小说', '镜子', '手段', '小心',
  '小费', '生煎', '小腿', '小海', '塔罗', '第一', '第二天', '第一天', '手机', '小孩', '小小', '小群', '小朋友',
  '电脑', '房间', '酒店', '衣服', '化妆', '出门', '时间', '问题', '稍微',
  '一点', '有点', '特别', '非常', '讨论', '回答', '提问', '礼物', '命运', '可能', '大概', '有些', '这么', '那种', '一个', '两个', '三个',
  // words that swallow a name fragment ("麦克风" -> "克风", "羽绒服" -> "羽绒")
  '麦克风', '羽绒服', '小飞机', '小矮人', '小熊猫', '小浣熊', '德克士', '克拉克', '小馋猫',
  '十月份', '十八斤', '小推', '小视', '小象', '小嘴', '小甜', '小伙', '小号', '小秘', '小型',
  '小萝', '小飞', '小夜', '小零', '小鬼', '小女', '小喽', '未来', '命名', '灰狼', '雅山',
  '花茶', '花糖', '花儿', '花谢', '花开', '小酒', '小偷', '小矮', '小米', '小红', '小熊',
  '小虎', '小猫', '小狼', '小鹿', '小龟', '小熊猫', '小海獭', '小绿', '小蓝', '小黑',
  '立刻', '里刻', '力克',
  // words the scan kept proposing against a real name and that the LLM confirmed to be
  // ordinary speech: 上厕/上完厕 are 上厕所 split by the ASR, 上迪 is the shorthand for
  // 上海迪士尼, 十五项 is a Disney pass option. Cities are places, not members.
  '上次', '上厕', '上完厕', '上面', '上去', '上迪', '米饭', '南京', '北京', '广州', '深圳',
  '杭州', '成都', '苏州', '东京', '日本', '中国', '宝宝', '空姐', '好姐', '小蛋糕', '花栗鼠',
  '十五项', '小公主', '小蛋糕', '小厨', '小厨店', '小肥', '小猛妹',
  // more ordinary words the model has tried to pass off as a member's name
  '御姐', '软妹', '命苦', '命好苦', '鼠兔', '小煤气', '羽化升', '优雅', '雅族', '生殖隔离',
]);

// title scaffolding that is never a person's name ("【无弹幕】", "直播录像" …)
const NON_NAME_TOKENS = ['弹幕', '直播', '录像', '录播', '回放', '测试', '版本', '纯净', '无', '半场', '切片', '精选', '名场面', '联动', '合集'];

// single grammar characters: a person's name never turns into one of these, so a
// candidate whose edit script replaces a name character with them is just the name
// plus the next character of the sentence.
const FUNCTION_CHARS = new Set(
  '的要是了被时后个们这那不也很么呢吧和与就都把给对让我你他她它但而如所因很一二三上下中内外每些'.split('')
);

// Ordinary conversational words that recur in every replay. The unknown-spelling
// scan has no edit-distance anchor, so it needs to know what ordinary speech looks
// like: a person's name never begins with a pronoun or a conjunction, and none of
// these are ever a name.
const FILLER_START_RE =
  /^(我|你|他|她|咱们|我们|你们|他们|她们|然后|所以|但是|因为|如果|虽然|不过|就是|可是|要不|对了|好的|是的|不是|没有|可以|这个|那个|这些|那些|这样|那么|怎么|什么|谁|啥)/;
const FILLER_WORDS = new Set([
  '谢谢', '拜拜', '晚安', '早安', '早上好', '中午好', '晚上好', '对对', '好好', '真的',
  '特别', '非常', '大概', '一点', '人家', '一下', '看到', '不懂', '后面', '早上',
  '等一下', '哎呦', '哎呀', '我靠', '哈哈', '哈哈哈', '好想你', '好想', '真是', '确实',
  '肯定', '应该', '感觉', '知道', '觉得', '开始', '结束', '时候', '东西', '好像',
]);

// pure number/time words ("十八", "十点半", "两分钟") are never names
const NUMBER_TOKEN_RE =
  /^[一二两三四五六七八九十百千万半多几]+(?:[点分][一二两三四五六七八九十百千万半多几]*秒?)?$/;

// number + unit ("十寸", "十八斤", "十五号", "十点早", "十多岁"): the ASR heard a
// quantity, and a name like 十六萤 produces "加六十"/"十寸" as an edit-distance
// neighbour. These are never people.
const NUMBER_UNIT_RE =
  /^[一二两三四五六七八九十百千万半多几]+(?:[多几][一二两三四五六七八九十百千万半多几]*)?[寸套人点厘吨块杯天月岁号管斤米次遍部本张双对份元条只个颗秒升桌碗份份]/;

// characters that sound the same, so the ASR can hear a name correctly and pick a
// different character for every syllable ("羽啾" -> "宇揪"). Used to rescue
// same-length candidates that share no character with the real spelling.
const HOMOPHONE = new Map();
for (const group of [
  '羽雨宇于愚郁', '啾揪秋九酒纠', '克客可刻科', '莉丽梨黎', '蔻扣口丘邱',
  '米迷弥', '雅牙呀芽', '罗萝洛', '小晓', '绿陆禄录', '命明', '依伊衣忆',
  '枝知芝之', '堇金进', '灰回惠', '泽则', '满蔓', '花华画', '姐接节',
  '团坛潭', '子字', '萤英影应', '星醒', '守瘦首手', '时实诗', '松嵩',
  // mishearings seen in real transcripts: 鼠姐/薯姐, 莉蔻/妮蔻, 未知夜/米奇亚,
  // 克罗雅/克洛雅, 小礼猫/小浣熊-style syllable swaps
  '鼠薯输殊树', '妮尼霓泥', '亚雅呀', '奇琪基其期', '夜业叶', '知芝之枝',
  '佐左座', '迪地狄', '礼李里理',
]) {
  for (const a of group) {
    if (!HOMOPHONE.has(a)) HOMOPHONE.set(a, new Set());
    for (const b of group) if (b !== a) HOMOPHONE.get(a).add(b);
  }
}

/** every syllable of `w` is a homophone of the corresponding character of `form` */
function isHomophoneForm(form, w) {
  if (w.length !== form.length || w.length < 2) return false;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === form[i]) continue;
    if (!HOMOPHONE.get(w[i]) || !HOMOPHONE.get(w[i]).has(form[i])) return false;
  }
  return true;
}

/** donation thank-you: "谢谢小飞机的棉花糖" — the ASR heard the fan name correctly */
function isDonorContext(ctx, w) {
  const i = ctx.indexOf(w);
  if (i < 0) return false;
  return /谢/.test(ctx.slice(Math.max(0, i - 14), i));
}

/** a viewer/fan name: "我叫小萌妹在看", "小安今天开心的粉三的牌" — a fan, not a member */
function isViewerContext(ctx, w) {
  const i = ctx.indexOf(w);
  if (i < 0) return false;
  const before = ctx.slice(Math.max(0, i - 14), i);
  const after = ctx.slice(i + w.length, i + w.length + 14);
  return /我叫|我是|粉丝|粉三|关注|在看|弹幕|观众|榜|礼物|牌/.test(before) || /\的(粉|牌|礼物|棉花糖|粉三)/.test(after);
}

/**
 * Characters an ASR plausibly writes for each syllable of a romanised name.
 * "Michiya" is heard as 米奇亚, which shares no character with 未知夜 and is five
 * edits away, so edit distance alone can never find it. Only the syllables that
 * occur in the names of the table are listed.
 */
const SYLLABLE_CHARS = {
  shi: '诗施知思斯', chi: '奇琪其期基绮', chu: '初出楚', mi: '米迷弥咪',
  ko: '克客可刻', lo: '罗萝洛落', li: '莉丽梨黎立礼里理', ya: '亚雅呀芽',
  ha: '哈海', rei: '蕾瑞雷', ri: '日瑞丽', o: '奥欧', vi: '维微威',
  dis: '迪斯', mei: '梅美眉', su: '苏素疏', re: '热蕾', ku: '库酷',
  ki: '基奇琪克', a: '阿啊', i: '伊衣依忆', ne: '奈内', sh: '诗施史',
  k: '克可柯科客', l: '莉勒罗', r: '瑞日尔', u: '乌优', h: '哈海',
  n: '奈内', t: '特拓', d: '迪地狄', j: '基吉季', y: '伊耶', g: '格哥古',
};

/** greedy syllabification of a latin name, or null when it cannot be split */
function syllables(latin) {
  const s = String(latin).toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 3) return null;
  const keys = Object.keys(SYLLABLE_CHARS).sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let hit = null;
    for (const k of keys) {
      if (s.startsWith(k, i)) {
        hit = k;
        break;
      }
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out.length >= 2 ? out : null;
}

/** romanised spellings in the table -> every CJK rendering of their sound */
function translitForms(pool) {
  const map = new Map();
  for (const f of pool.forms.values()) {
    if (isCJK(f.raw)) continue;
    const syl = syllables(f.raw);
    if (!syl) continue;
    let combos = [''];
    for (const k of syl) {
      const next = [];
      for (const c of combos) {
        for (const ch of SYLLABLE_CHARS[k]) {
          if (next.length < 400) next.push(c + ch);
        }
      }
      combos = next;
      if (!combos.length) break;
    }
    for (const c of combos) {
      if (!map.has(c)) map.set(c, f.canonical);
    }
  }
  return map;
}

/** the candidate is a piece of running text: "在可" inside "现在可能" */
function isProseContext(ctx, w) {
  for (const run of ctx.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    const i = run.indexOf(w);
    if (i < 0) continue;
    for (const cw of COMMON_WORDS) {
      let j = run.indexOf(cw);
      while (j >= 0) {
        if (j < i + w.length && j + cw.length > i) return true;
        j = run.indexOf(cw, j + 1);
      }
    }
  }
  return false;
}

function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_·\-–—]/g, '');
}

function isCJK(s) {
  return /^[\u4e00-\u9fff]+$/.test(s);
}

/** Levenshtein distance, capped at `max` (returns max+1 when farther). */
function levenshtein(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  let prev = new Array(n + 1);
  for (let i = 0; i <= n; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    const cur = [j];
    let best = j;
    const bj = b[j - 1];
    for (let i = 1; i <= n; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === bj ? 0 : 1));
      if (cur[i] < best) best = cur[i];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}

/**
 * Names that look like "莉蔻Liko" / "枝堇Sumire" / "【克罗雅】". Used for the
 * streamer entries and video titles.
 */
function extractNames(text) {
  const out = [];
  const t = String(text || '');
  for (const m of t.match(/[\u4e00-\u9fff]{2,4}\s*[A-Za-z][A-Za-z0-9]{2,15}/g) || []) {
    const cjk = m.match(/^[\u4e00-\u9fff]+/)[0];
    const latin = m.match(/[A-Za-z][A-Za-z0-9]{2,15}/)[0];
    if (NAME_STOPWORDS.has(latin.toLowerCase())) continue;
    // "上海repo" is a place plus a tag, not a person: the same filter the 【…】
    // branch uses has to apply here too, otherwise a city becomes a member.
    if (COMMON_WORDS.has(cjk)) continue;
    if (NON_NAME_TOKENS.some((t2) => cjk.includes(t2))) continue;
    out.push({ name: cjk, english: latin });
  }
  for (const m of t.match(/【([\u4e00-\u9fff]{2,6})】/g) || []) {
    const name = m.slice(1, -1);
    if (COMMON_WORDS.has(name)) continue;
    if (NON_NAME_TOKENS.some((t2) => name.includes(t2))) continue;
    out.push({ name });
  }
  return out;
}

/** Seed the name table from streamer entries and a video title. */
function seedNames(texts) {
  const added = [];
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    for (const n of extractNames(text)) {
      const row = db.upsertName({ name: n.name, english: n.english || '', source: 'title' });
      if (row) added.push(row.name);
    }
  }
  return added;
}

function seedFromStreamers() {
  const added = [];
  for (const s of db.listStreamers()) {
    // the streamer entry itself: "莉蔻Liko" style names
    for (const n of extractNames(`${s.name || ''} ${s.english || ''}`)) {
      const row = db.upsertName({ name: n.name, english: n.english || '', source: 'user' });
      if (row) added.push(row.name);
    }
    // the `match` filter tokens are names the user typed by hand (e.g. "克罗雅")
    for (const tok of String(s.match || '').split(',')) {
      const v = tok.trim();
      if (v && isCJK(v) && v.length >= 2 && !COMMON_WORDS.has(v)) {
        const row = db.upsertName({ name: v, source: 'user', note: '主播匹配关键词' });
        if (row) added.push(row.name);
      }
    }
  }
  return added;
}

/** Seed from every job title we have already seen: titles name the people involved. */
function seedFromJobs() {
  const titles = db.listJobs(200).map((j) => j.title || '').filter(Boolean);
  const added = [];
  for (const n of extractNames(titles.join('\n'))) {
    const row = db.upsertName({ name: n.name, english: n.english || '', source: 'title' });
    if (row) added.push(row.name);
  }
  return added;
}

/**
 * The spellings the ASR produces for a name are systematic: "克罗雅" is heard as
 * "克朗" in most recordings, "未知夜" as "米米". Those forms are often too far from
 * the table spelling for the edit-distance scan to reach (no shared character, no
 * same-syllable substitution), so they would never even reach the model.
 *
 * Every correction the model has already confirmed is stored on the job
 * (jobs.name_fixes), so the known mishearings of a name are learned from the
 * reports that were corrected before, and written into the name table where the
 * user can inspect or prune them.
 */
function learnMishearings() {
  const byName = new Map(); // canonical -> Map(wrong -> hits)
  for (const job of db.listJobs(500)) {
    for (const f of parseFixes(job.name_fixes)) {
      const wrong = String(f.wrong || '').trim();
      const correct = String(f.correct || '').trim();
      if (!wrong || !correct || wrong.length < 2) continue;
      if (!byName.has(correct)) byName.set(correct, new Map());
      const m = byName.get(correct);
      m.set(wrong, (m.get(wrong) || 0) + (Number(f.count) || 1));
    }
  }
  let added = 0;
  for (const [name, wrongs] of byName) {
    const before = db.getName(name);
    if (!before) continue;
    const after = db.addMishearings(name, [...wrongs.keys()]);
    if (!after) continue;
    const known = new Set(String(before.mishearings || '').split(',').map((x) => norm(x)));
    added += [...wrongs.keys()].filter((w) => !known.has(norm(w))).length;
  }
  if (added) console.log(`[names] learned ${added} new mishearing form(s) from confirmed corrections`);
}

/** { entries, forms: Map(normalized -> { raw, canonical }) } */
function buildPool() {
  learnMishearings();
  const entries = db.listNames().map((r) => ({
    id: r.id,
    name: r.name,
    english: r.english || '',
    aliases: String(r.aliases || '').split(',').map((a) => a.trim()).filter(Boolean),
    mishearings: String(r.mishearings || '').split(',').map((a) => a.trim()).filter(Boolean),
    note: r.note || '',
    source: r.source,
  }));
  const forms = new Map();
  const add = (raw, canonical) => {
    const rawClean = String(raw || '').trim();
    if (!rawClean) return;
    const key = norm(rawClean);
    if (!key || forms.has(key)) return;
    forms.set(key, { raw: rawClean, canonical });
  };
  for (const e of entries) {
    add(e.name, e.name);
    for (const a of e.aliases) add(a, e.name);
    for (const a of String(e.english).split(',')) add(a, e.name);
  }
  // a mishearing that happens to be a spelling the table already knows is not an error
  for (const e of entries) {
    e.mishearings = e.mishearings.filter((w) => w !== e.name && !forms.has(norm(w)));
  }
  return { entries, forms };
}

/** full edit script (<= limit) between two strings, or null if too far apart */
function editOps(a, b, limit) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return null;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  if (dp[n][m] > limit) return null;
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      i--;
      j--;
    } else if (dp[i - 1][j - 1] + 1 === dp[i][j]) {
      ops.push({ from: a[i - 1], to: b[j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] + 1 === dp[i][j]) {
      ops.push({ from: a[i - 1], to: '' });
      i--;
    } else {
      ops.push({ from: '', to: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ from: a[i - 1], to: '' });
    i--;
  }
  while (j > 0) {
    ops.push({ from: '', to: b[j - 1] });
    j--;
  }
  return { dist: dp[n][m], ops };
}

/**
 * Characters a near-miss of `form` can contain: its own characters plus the
 * same-syllable substitutions the ASR can hear. A window containing none of them
 * is not within edit distance 2 of this name, so it can be skipped before the
 * (comparatively expensive) edit script is computed.
 */
function allowedChars(form) {
  const out = new Set();
  for (const c of form) {
    out.add(c);
    const hom = HOMOPHONE.get(c);
    if (hom) for (const h of hom) out.add(h);
  }
  return out;
}

// A person's name in speech stands alone: it follows punctuation, a space, or the
// ASR speaker tag. A string that only ever occurs glued to the character before it
// ("麦克风" inside 麦克风, "小浣熊" inside 小浣熊) is a fragment of an ordinary
// word, not a name the ASR heard wrong.
const NAME_CUES_BEFORE = new Set('和跟与对向叫找约让帮给说问看讲告诉聊拜访问'.split(''));

/** { total, named } — how often `w` occurs in a position a name could occupy */
function nameShape(text, w) {
  let total = 0;
  let named = 0;
  let from = 0;
  while (true) {
    const i = text.indexOf(w, from);
    if (i < 0) break;
    total++;
    const before = i > 0 ? text[i - 1] : '';
    if (!/[\u4e00-\u9fff]/.test(before) || NAME_CUES_BEFORE.has(before)) named++;
    from = i + w.length;
  }
  return { total, named };
}

// What a token is used for in a sentence. A person's name is the object of a cue
// ("和妮可", "叫妮可") or the subject of something a person does or is ("妮可说",
// "妮可的"). An ordinary conversational word is followed by a new subject or a
// clause ("然后我", "反正对", "拜拜，").
const PERSON_PREDICATE_RE = /[说讲叫是想要来去和被让帮找问给做干在听吃喝睡玩写播买拿带送开站坐走跑唱跳试尝洗弄打拍签推拉教]/;
const SUBJECT_START_RE = /[我你他她它咱大家这那然就还又不没对真好特非常大概应该肯定其实]/;

/** { total, cue, pred, subj } — how often `w` is used the way a name is used */
function personUsage(text, w) {
  let total = 0;
  let cue = 0;
  let pred = 0;
  let subj = 0;
  let from = 0;
  while (true) {
    const i = text.indexOf(w, from);
    if (i < 0) break;
    total++;
    const before = i > 0 ? text[i - 1] : ' ';
    const after = text.slice(i + w.length, i + w.length + 1) || ' ';
    if (NAME_CUES_BEFORE.has(before)) cue++;
    if (PERSON_PREDICATE_RE.test(after)) pred++;
    else if (SUBJECT_START_RE.test(after)) subj++;
    from = i + w.length;
  }
  return { total, cue, pred, subj };
}

/** how many candidates the LLM is asked to confirm for a text of `chars` length */
function candidateCap(chars) {
  const byLength = MAX_CANDIDATES + Math.ceil(chars / 20000) * CANDIDATE_CAP_STEP;
  return Math.max(MAX_CANDIDATES, Math.min(CANDIDATE_CAP_MAX, byLength));
}

/** deterministic scan: candidate misspellings with counts and context */
function scanCandidates(text, pool) {
  const full = String(text || '');
  const scan = MAX_SCAN_CHARS > 0 ? full.slice(0, MAX_SCAN_CHARS) : full;
  const cap = candidateCap(scan.length);
  const cjkWindows = new Map();
  // A window that touches a correct spelling is never a mishearing: "雅解" comes
  // from "克罗雅 解释…", "礼礼" from "花礼 礼…". Mark every position covered by a
  // known spelling and only look at windows that sit away from them.
  const cjkForms = [...pool.forms.values()].map((f) => f.raw).filter(isCJK);
  // A near-miss is within edit distance 2 of a known spelling, so only windows of
  // those lengths can ever be candidates.
  const windowLengths = new Set();
  for (const f of pool.forms.values()) {
    for (let L = Math.max(2, f.raw.length - 2); L <= Math.min(6, f.raw.length + 2); L++) windowLengths.add(L);
  }
  for (const run of scan.match(/[\u4e00-\u9fff]+/g) || []) {
    const covered = new Array(run.length).fill(false);
    for (const s of cjkForms) {
      for (let i = 0; i + s.length <= run.length; i++) {
        if (run.slice(i, i + s.length) !== s) continue;
        for (let k = i; k < i + s.length; k++) covered[k] = true;
      }
    }
    for (const L of windowLengths) {
      for (let i = 0; i + L <= run.length; i++) {
        if (covered.slice(Math.max(0, i - 1), i + L + 1).some(Boolean)) continue;
        const w = run.slice(i, i + L);
        cjkWindows.set(w, (cjkWindows.get(w) || 0) + 1);
      }
    }
  }
  const latinWindows = new Map();
  // "LicoLiko" is one run of letters, but it is two names glued together: split
  // runs at capital boundaries so "Lico" is still seen as a near-miss of "Liko".
  for (const run of scan.match(/[A-Za-z]{3,15}/g) || []) {
    for (const w of run.split(/(?=[A-Z])/)) {
      if (w.length < 3) continue;
      latinWindows.set(w, (latinWindows.get(w) || 0) + 1);
    }
  }

  // every substring of a known spelling is not a candidate: "克罗" is just part
  // of "克罗雅", not a mishearing.
  const knownSubstrings = new Set();
  for (const f of pool.forms.values()) {
    const s = f.raw;
    for (let L = 2; L < s.length; L++) {
      for (let i = 0; i + L <= s.length; i++) knownSubstrings.add(s.slice(i, i + L));
    }
  }
  const knownSub = [...knownSubstrings].filter(isCJK);

  const best = new Map(); // wrong -> { wrong, count, dist, canonical, score }
  for (const f of pool.forms.values()) {
    const form = f.raw;
    // An alias such as "雅雅" is a valid spelling, but a near-miss of an alias is
    // only worth checking when the ASR makes the same mistake more than once: an
    // alias is usually short ("雅雅") and edit distance 2 from it reaches a lot of
    // ordinary prose ("雅神"/"雅声").
    const isAlias = isCJK(form) && form !== f.canonical;
    const windows = isCJK(form) ? cjkWindows : latinWindows;
    if (!isCJK(form) && form.length < 3) continue;
    const chars = new Set(form);
    const allowed = allowedChars(form);
    for (const [w, count] of windows) {
      if (w === form || knownSubstrings.has(w)) continue;
      // cheap rejection first: a mishearing of this name either shares one of its
      // characters or replaces every character by a same-syllable one
      let plausible = false;
      for (const c of w) {
        if (allowed.has(c)) {
          plausible = true;
          break;
        }
      }
      if (!plausible) continue;
      if (w.includes(form) || form.includes(w)) continue; // fragment, or name + prose
      // "罗雅解" is the correct name plus the next character of the sentence
      if (isCJK(w) && knownSub.some((s) => w.includes(s))) continue;
      if (isCJK(w) && COMMON_WORDS.has(w)) continue;
      if (pool.forms.has(norm(w))) continue; // already a known spelling
      const script = editOps(form, w, 2);
      if (!script || script.dist < 1) continue;
      // a real mishearing keeps at least the first sound, or shares two characters
      // (薯姐 -> 鼠姐 keeps 姐). Everything else is ordinary prose. Exception: if
      // only the first character differs and the rest matches exactly, it is the same
      // name heard wrong (雨揪 -> 宇揪, 克郎 -> 克罗雅 style errors).
      const shared = [...w].filter((c) => chars.has(c)).length;
      const tailMatch = w.length === form.length && w.slice(1) === form.slice(1);
      const homophoneMatch = isCJK(w) && isHomophoneForm(form, w);
      if (w[0] !== form[0] && shared < 2 && !tailMatch && !homophoneMatch) continue;
      // a weak match (only one character in common, or pure homophone substitution)
      // is only evidence when the ASR makes the same mistake more than once.
      if (shared < 2 && count < 2) continue;
      if (isAlias && count < 2) continue;
      // a name never becomes a grammar word: "克朗要" is the name plus the next
      // character of the sentence, not a mishearing.
      if (isCJK(w) && script.ops.some((op) => op.to && FUNCTION_CHARS.has(op.to))) continue;
      // a distance-2 accident in running text is usually a coincidence; a name the
      // ASR keeps getting wrong shows up repeatedly.
      if (script.dist === 2 && count < 2) continue;
      // "十八厘米" / "十点半" are numbers, not names
      if (isCJK(w) && NUMBER_TOKEN_RE.test(w)) continue;
      if (isCJK(w) && NUMBER_UNIT_RE.test(w)) continue;
      // "克风" ×17 is 麦+克风 inside 麦克风: every occurrence is glued to the
      // character before it, so it never occupies a name position.
      const shape = nameShape(full, w);
      if (shape.named === 0 && shape.total >= 2) continue;
      const ctxs = contexts(full, w);
      // a fan who donates ("谢谢小飞机的棉花糖") is a real name the ASR heard right;
      // if every occurrence sits in a donation thank-you, this is not a streamer name.
      // Likewise a candidate that only ever appears inside an ordinary word
      // ("在可" in "现在可能") is running text, not a misheard name.
      if (ctxs.length && ctxs.every((c) => isDonorContext(c, w) || isViewerContext(c, w) || isProseContext(c, w))) continue;
      // real mishearings are systematic and stand alone; prose fragments do not.
      const score = shape.named * 5 - (shape.total - shape.named);
      const prev = best.get(w);
      if (
        !prev ||
        script.dist < prev.dist ||
        (script.dist === prev.dist && (score > prev.score || (score === prev.score && count > prev.count)))
      ) {
        best.set(w, { wrong: w, count, dist: script.dist, canonical: f.canonical, score, contexts: ctxs });
      }
    }
  }

  // Known mishearings of a name (learned from corrections confirmed on earlier
  // replays, or entered in the name table) are looked up directly: they are often
  // two characters away from the table spelling with no sound in common, so the
  // edit-distance scan above can never reach them ("克朗" for 克罗雅, "米米" for
  // 未知夜). They are confirmed by the model like any other candidate.
  //
  // The count ignores positions that belong to a correct spelling: "雅罗" inside
  // "克罗雅罗" is the name plus the next character of the sentence, not the ASR
  // writing the name wrong.
  const covered = new Uint8Array(full.length);
  for (const s of cjkForms) {
    for (let i = 0; i + s.length <= full.length; i++) {
      if (full.slice(i, i + s.length) !== s) continue;
      for (let k = i; k < i + s.length; k++) covered[k] = 1;
    }
  }
  for (const e of pool.entries) {
    for (const w of e.mishearings) {
      if (w.length < 2 || best.has(w) || pool.forms.has(norm(w))) continue;
      if (isCJK(w) && COMMON_WORDS.has(w)) continue;
      let count = 0;
      for (let i = 0; i + w.length <= full.length; i++) {
        if (full.slice(i, i + w.length) !== w) continue;
        if (covered.slice(i, i + w.length).some(Boolean)) continue;
        count++;
      }
      if (count === 0) continue;
      const shape = nameShape(full, w);
      // a form that only ever occurs glued to the character before it is usually a
      // fragment of an ordinary word; a form the ASR really writes for this name
      // shows up repeatedly, so several occurrences are enough evidence on their own
      if (shape.named === 0 && count < 3) continue;
      const ctxs = contexts(full, w);
      if (ctxs.length && ctxs.every((c) => isDonorContext(c, w) || isViewerContext(c, w) || isProseContext(c, w))) continue;
      const score = Math.max(shape.named, 0) * 5 - (shape.total - shape.named) + 20 + Math.min(count, 20);
      best.set(w, { wrong: w, count, dist: 0, canonical: e.name, score, known: true, contexts: ctxs });
    }
  }

  // A romanised name can be heard as a CJK transliteration of its sound (未知夜
  // "Michiya" -> 米奇亚). Such a token is nowhere near the table spelling in edit
  // distance, so it is looked up separately. Only systematic ones count.
  for (const [w, canonical] of translitForms(pool)) {
    const count = cjkWindows.get(w);
    if (!count || count < 2) continue;
    if (best.has(w) || pool.forms.has(norm(w)) || COMMON_WORDS.has(w)) continue;
    const shape = nameShape(full, w);
    if (shape.named < 1) continue;
    const ctxs = contexts(full, w);
    if (ctxs.length && ctxs.every((c) => isDonorContext(c, w) || isViewerContext(c, w) || isProseContext(c, w))) continue;
    best.set(w, { wrong: w, count, dist: 1, canonical, score: shape.named * 5 - (shape.total - shape.named), contexts: ctxs });
  }

  // A spelling that is nowhere near any table entry, but recurs in name positions
  // through the whole transcript, is the ASR consistently writing one member's name
  // as another word. It is offered to the model as an unknown spelling (the model
  // decides whether it is a member, a viewer, or an ordinary word).
  const unknown = new Map();
  for (const [w, count] of cjkWindows) {
    if (w.length < 2 || w.length > 4 || count < UNKNOWN_MIN_COUNT) continue;
    if (best.has(w) || pool.forms.has(norm(w)) || COMMON_WORDS.has(w)) continue;
    if (FILLER_START_RE.test(w) || FILLER_WORDS.has(w)) continue;
    if (knownSub.some((s) => w.includes(s))) continue;
    if (NON_NAME_TOKENS.some((t) => w.includes(t))) continue;
    if (NUMBER_TOKEN_RE.test(w) || NUMBER_UNIT_RE.test(w)) continue;
    // every occurrence glued to the character before it is running text, not a name
    const shape = nameShape(full, w);
    if (shape.named < UNKNOWN_MIN_COUNT) continue;
    // the token has to be used as a person, not as the start of a clause: a name
    // follows a cue ("和妮可") or is followed by what a person does or is
    const use = personUsage(full, w);
    if (use.cue + use.pred < 2 || use.cue + use.pred <= use.subj) continue;
    const ctxs = contexts(full, w);
    if (ctxs.length && ctxs.every((c) => isDonorContext(c, w) || isViewerContext(c, w) || isProseContext(c, w))) continue;
    unknown.set(w, {
      wrong: w,
      count,
      dist: 3,
      canonical: null,
      unknown: true,
      score: shape.named * 5 + use.cue * 3 + use.pred * 2 - use.subj * 2 - (shape.total - shape.named),
      contexts: ctxs,
    });
  }

  // drop a candidate that is another candidate plus one character of the sentence
  const all = [...best.values()];
  const kept = all.filter(
    (c) =>
      !all.some(
        (o) =>
          o !== c &&
          o.canonical === c.canonical &&
          o.wrong.length < c.wrong.length &&
          c.wrong.includes(o.wrong) &&
          // "克兰一" is 克兰 plus the next character of the sentence, so the shorter
          // form is the real one whenever it occurs at least as often. Equal counts
          // mean they are the same mishearing written two ways (米奇 / 米奇亚), and
          // both are kept: applyFixes replaces the longest first, so nothing is
          // mangled.
          o.count > c.count
      )
  );

  // strongest evidence first: a name the ASR systematically gets wrong appears
  // repeatedly and in name positions. Then the cap is filled round-robin across the
  // names in the table, so one noisy name (e.g. every fragment of 十六萤) cannot
  // crowd out a genuine mishearing of another member.
  kept.sort((a, b) => (b.known ? 1 : 0) - (a.known ? 1 : 0) || b.score - a.score || b.count - a.count || a.dist - b.dist);
  const groups = new Map();
  for (const c of kept) {
    if (!groups.has(c.canonical)) groups.set(c.canonical, []);
    groups.get(c.canonical).push(c);
  }
  // A substitution that no table spelling is anywhere near ("妮可" for 莉蔻Liko) can
  // only be found by the unknown-spelling scan above, so it gets its own bounded
  // section rather than competing with near-miss candidates for the cap.
  const unknownAll = [...unknown.values()].filter((c) => !best.has(c.wrong));
  const unknownList = unknownAll
    // "的对的" is "的对" repeated in speech, so the shorter form is the token the
    // ASR actually writes whenever it occurs at least as often
    .filter((c) => !unknownAll.some((o) => o !== c && c.wrong.startsWith(o.wrong) && o.count >= c.count))
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, UNKNOWN_MAX);
  const perGroup = Math.max(4, Math.ceil(cap / groups.size));
  const list = [];
  for (let i = 0; list.length < cap; i++) {
    let added = false;
    for (const g of groups.values()) {
      if (i < g.length && i < perGroup) {
        list.push(g[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  for (const c of unknownList) {
    list.push(c);
  }
  for (const c of list) {
    c.contexts = contexts(full, c.wrong);
  }
  return list;
}

/** ASR timing/speaker tokens ("[12.34][S01]") are noise in a context snippet */
const ASR_TOKEN_RE = /\[\d+(?:\.\d+)?\]|\[S\d+\]/g;

function contexts(text, needle) {
  const positions = [];
  let from = 0;
  while (true) {
    const i = text.indexOf(needle, from);
    if (i < 0) break;
    positions.push(i);
    from = i + needle.length;
  }
  if (!positions.length) return [];
  // Sample across the whole transcript rather than the first N hits: the opening
  // minutes are where an ordinary word is used most and a name least, so a first-N
  // sample biases every judgement towards "ordinary word".
  const want = Math.min(CONTEXTS_PER_CANDIDATE, positions.length);
  const out = [];
  for (let k = 0; k < want; k++) {
    const i = positions[Math.floor((k * positions.length) / want)];
    const a = Math.max(0, i - CONTEXT_CHARS);
    const b = Math.min(text.length, i + needle.length + CONTEXT_CHARS);
    out.push(
      text
        .slice(a, b)
        .replace(ASR_TOKEN_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  return out;
}

function parseJsonArray(text) {
  const m = String(text || '').match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** one bounded LLM call: which candidates are really misheard names? */
async function askFixes(pool, candidates, reportText, signal) {
  const table = pool.entries
    .map(
      (e) =>
        `- ${e.name}` +
        (e.english ? ` (${e.english})` : '') +
        (e.aliases.length ? ` 别名: ${e.aliases.join(', ')}` : '') +
        (e.note ? ` 备注: ${e.note}` : '')
    )
    .join('\n');

  // Candidates are grouped by the name they are closest to: the model judges a
  // handful of near-misses of one person far more reliably than a flat list.
  const promptFor = (list) => {
    const groups = new Map();
    for (const c of list) {
      if (!groups.has(c.canonical)) groups.set(c.canonical, []);
      groups.get(c.canonical).push(c);
    }
    const lines = [];
    for (const [canonical, items] of groups) {
      if (!canonical) {
        // the program cannot attach these to anybody: they are nowhere near a table
        // spelling, they only recur where a name belongs
        lines.push('以下写法在转录中反复出现，姓名表里没有对应的人，程序无法判断它指谁：');
        for (const c of items) {
          lines.push(
            `- 「${c.wrong}」 出现 ${c.count} 次` +
              (c.contexts.length ? `\n  上下文: ${c.contexts.map((x) => `…${x}…`).join(' ┃ ')}` : '')
          );
        }
        continue;
      }
      const entry = pool.entries.find((e) => e.name === canonical);
      const known = entry && entry.mishearings.length ? `（常见错写: ${entry.mishearings.slice(0, 8).join(', ')}）` : '';
      lines.push(`关于「${canonical}」${known}:`);
      for (const c of items) {
        lines.push(
          `- 「${c.wrong}」 出现 ${c.count} 次` +
            (c.known ? `（以往录像中已确认的「${canonical}」错写）` : `（与「${canonical}」发音/写法最接近）`) +
            (c.contexts.length ? `\n  上下文: ${c.contexts.map((x) => `…${x}…`).join(' ┃ ')}` : '')
        );
      }
    }
    return [
      '下面是一段 B站 VTuber 直播录像的转录片段。语音转文字（ASR）经常把人名写成发音相近的错词。',
      '',
      '【姓名表】（正确写法）',
      table,
      '',
      '【候选错词】（程序自动找出，可能包含普通词语，需要你判断每一个是否真的是人名被写错）',
      lines.join('\n'),
      '',
      '请输出 JSON 数组，每项形如 {"wrong": "克洛雅", "correct": "克罗雅"}。',
      '规则：',
      '1. correct 必须是姓名表里的名字或其别名（别名会自动归并为正式写法）。',
      '2. 只有上下文里确实在指一个人（人名）的候选才输出。普通词语不是人名：例如「麦克风」里的「克风」、「小熊猫」、「羽绒服」、「十斤」、「十月份」都不输出。',
      '3. 观众或粉丝的名字（如「我叫小萌妹在看」「小安的粉三」）不是组合成员的名字，不输出。',
      '4. 「常见错写」是以往录像中已确认的错写：同一个名字在不同录像里通常错成同一写法（如克罗雅写成「克朗」、未知夜写成「米米」）。上下文确实在指该人时应当输出；上下文明显是普通词语或别人时不输出。',
      '5. 罗马字名字可能被音译成发音相近的中文（如 Michiya 写成「米奇亚」指未知夜），上下文确实在指这个人时应当输出。',
      '6. 姓名表里没有的写法（程序无法判断它指谁）：如果上下文表明它确实指某位成员——罗马字名字被听成另一个人名，如 Liko 写成「妮可」指莉蔻——输出 {"wrong": "妮可", "correct": "莉蔻"}；指观众或只是普通词语时不输出。',
      '7. 同一个错词若有长短两种写法（如「米奇」和「米奇亚」），输出完整的那个。',
      '8. 如果某个写法本身就是姓名表里的写法，不要输出。',
      '9. 同一名字的不同错写分别列出。上下文不足以判断时，不要猜测，不输出。',
      '10. 只输出 JSON，不要解释，不要代码块。没有需要修正的候选时输出 []。',
    ].join('\n');
  };

  // The local model gets unreliable when the prompt gets long, so the candidates
  // are confirmed in small batches (most frequent first) and merged. A batch that
  // fails is retried once as two halves: every candidate still gets a chance, none
  // is silently dropped because the batch had to be shortened. Splitting is capped
  // and the whole phase has a time budget, so a slow or unresponsive model can never
  // turn this into an unbounded number of calls.
  const out = [];
  const deadline = Date.now() + PHASE_BUDGET_MS;

  async function confirm(list, depth = 0) {
    if (signal && signal.aborted) throw new Error('cancelled');
    if (Date.now() > deadline) {
      console.warn(`[names] time budget ${PHASE_BUDGET_MS}ms reached, ${list.length} candidate(s) left unconfirmed`);
      return [];
    }
    try {
      const fixes = validateFixes(
        parseJsonArray(
          await chat(
            [{ role: 'user', content: promptFor(list) }],
            { maxTokens: 1500, temperature: 0.1, reasoning: 'none', signal, timeoutMs: CALL_TIMEOUT_MS }
          )
        ),
        pool
      );
      // The local model sometimes answers "nothing to fix" for a batch it did not
      // read carefully: the same candidates confirmed one by one come back as real
      // mishearings. Asking again with the batch halved recovers what the long prompt
      // lost, and a genuinely empty batch just returns [] again.
      if (!fixes.length && list.length > 1 && depth < MAX_SPLIT_DEPTH) {
        const mid = Math.ceil(list.length / 2);
        console.warn(`[names] batch of ${list.length} candidates confirmed nothing, re-asking as two halves`);
        const halves = [
          ...(await confirm(list.slice(0, mid), depth + 1)),
          ...(await confirm(list.slice(mid), depth + 1)),
        ];
        if (halves.length) return halves;
      }
      return fixes;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (list.length <= 1 || depth >= MAX_SPLIT_DEPTH) {
        console.warn(`[names] LLM batch failed (${err.message}), ${list.length} candidate(s) left unconfirmed`);
        return [];
      }
      const mid = Math.ceil(list.length / 2);
      console.warn(`[names] LLM batch of ${list.length} candidates failed (${err.message}), retrying as two halves`);
      return [...(await confirm(list.slice(0, mid), depth + 1)), ...(await confirm(list.slice(mid), depth + 1))];
    }
  }

  let checked = 0;
  for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH) {
    if (Date.now() > deadline) {
      console.warn(`[names] time budget reached, ${candidates.length - i} candidate(s) not checked`);
      break;
    }
    const batch = candidates.slice(i, i + CANDIDATE_BATCH);
    const fixes = await confirm(batch);
    checked += batch.length;
    for (const f of fixes || []) {
      if (!out.some((x) => norm(x.wrong) === norm(f.wrong))) out.push(f);
    }
  }
  if (out.length) {
    console.log(`[names] confirmed ${out.length} name fixes from ${checked} candidates`);
  } else if (candidates.length) {
    console.log(
      `[names] ${checked} candidates checked: none is a misheard name (ordinary words or already-correct spellings)`
    );
  } else {
    console.log('[names] no near-miss candidates found in the transcript');
  }
  return out;
}

/** keep only fixes whose `correct` is in the name table */
function validateFixes(raw, pool) {
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const wrong = String(item.wrong || '').trim();
    let correct = String(item.correct || '').trim();
    if (!wrong || !correct || norm(wrong) === norm(correct)) continue;

    const hit = pool.forms.get(norm(correct));
    if (hit) {
      correct = hit.canonical;
    } else {
      // tolerate a typo in the model's output, e.g. "克罗雅" -> "克罗雅"
      let best = null;
      for (const f of pool.forms.values()) {
        const d = levenshtein(f.raw, correct, 1);
        if (d <= 1 && (!best || d < best.d)) best = { d, canonical: f.canonical };
      }
      if (!best) continue;
      correct = best.canonical;
    }
    if (norm(wrong) === norm(correct)) continue;
    if (pool.forms.has(norm(wrong))) continue; // wrong is a valid spelling
    if (isCJK(wrong) && COMMON_WORDS.has(wrong)) continue; // ordinary word, not a name
    if (!out.some((x) => norm(x.wrong) === norm(wrong))) out.push({ wrong, correct });
  }
  return out;
}

/** deterministic string replacement; returns applied counts */
function applyFixes(text, fixes) {
  let out = String(text || '');
  const applied = [];
  const sorted = [...fixes].sort((a, b) => b.wrong.length - a.wrong.length);
  for (const f of sorted) {
    if (fixes.some((g) => norm(g.wrong) === norm(f.correct))) continue; // avoid chains
    let count = 0;
    if (isCJK(f.wrong)) {
      const parts = out.split(f.wrong);
      count = parts.length - 1;
      if (count > 0) out = parts.join(f.correct);
    } else {
      const re = new RegExp(`\\b${f.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      out = out.replace(re, () => {
        count++;
        return f.correct;
      });
    }
    if (count > 0) applied.push({ wrong: f.wrong, correct: f.correct, count });
  }
  return { text: out, applied };
}

/**
 * Reverse a list of applied fixes: turn every `correct` back into `wrong`.
 * Used to rebuild the untouched original text when the name table changes, so a
 * correction pass can always be regenerated from scratch.
 */
function unapplyFixes(text, fixes) {
  let out = String(text || '');
  const sorted = [...fixes].sort((a, b) => b.correct.length - a.correct.length);
  for (const f of sorted) {
    if (!f || !f.wrong || !f.correct) continue;
    if (fixes.some((g) => norm(g.correct) === norm(f.wrong))) continue; // would chain
    if (isCJK(f.correct)) {
      out = out.split(f.correct).join(f.wrong);
    } else {
      const re = new RegExp(`\\b${f.correct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      out = out.replace(re, () => f.wrong);
    }
  }
  return out;
}

function parseFixes(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** newest first, deduplicated by the wrong spelling */
function mergeFixes(a, b) {
  const out = [];
  for (const f of [...a, ...b]) {
    if (!out.some((x) => norm(x.wrong) === norm(f.wrong))) out.push(f);
  }
  return out;
}

function readTranscript(job) {
  const candidates = [job.transcript_path, transcriptPathFor(job)];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && (parsed.text || (parsed.segments && parsed.segments.length))) return { path: p, data: parsed };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** the transcript as the ASR produced it, before any name replacement (may be absent) */
function readRawTranscript(job) {
  const p = rawTranscriptPathFor(job);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && (parsed.text || (parsed.segments && parsed.segments.length))) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Full correction pass for one job, always against the **current** name table:
 * 1. undo the corrections this job recorded earlier that the current table no longer
 *    supports (a name was removed or renamed),
 * 2. scan report + transcript for near-miss spellings,
 * 3. let the LLM confirm which of them are real ASR mishearings,
 * 4. apply the replacements to the report text, the transcript JSON file and the DB.
 *
 * Corrections that the table still supports are kept, so clicking 「姓名修正」 again
 * after editing the table can only add or revert fixes, never silently lose them.
 */
async function correctNames(jobId, { reportText = null, signal } = {}) {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  seedNames([job.title, job.streamer_name]);
  const pool = buildPool();
  if (!pool.entries.length) return { fixes: [], applied: [], reason: 'name table is empty' };

  const recorded = parseFixes(job.name_fixes);
  const supported = validateFixes(recorded, pool);
  // fixes whose target name is no longer in the table: they have to be undone
  const stale = recorded.filter((f) => !supported.some((s) => norm(s.wrong) === norm(f.wrong)));

  // The untouched report and transcript are kept (report_raw / transcript-*.raw.json),
  // so a correction pass is always rebuilt from the original text. Without them undoing
  // a fix means replacing *every* occurrence of the correct spelling back with the wrong
  // one, which is wrong whenever the correct spelling also occurs as an ordinary word.
  const rawTranscript = readRawTranscript(job);
  const transcript = readTranscript(job);
  const report = reportText !== null ? String(reportText) : String(job.report || '');
  const rawReport = reportText !== null ? report : String(job.report_raw || '');

  let data = null;
  if (transcript) {
    data = rawTranscript || transcript.data;
    if (!rawTranscript && stale.length) {
      if (Array.isArray(data.segments)) {
        for (const seg of data.segments) {
          if (typeof seg.text === 'string') seg.text = unapplyFixes(seg.text, stale);
        }
      }
      if (typeof data.text === 'string') data.text = unapplyFixes(data.text, stale);
    }
  }
  const reportNow = rawReport || (report ? unapplyFixes(report, stale) : '');

  const scan = [reportNow, data && data.text].filter(Boolean).join('\n');
  let candidates = [];
  let fresh = [];
  try {
    candidates = scanCandidates(scan, pool);
    console.log(
      `[names] job ${jobId}: scanned ${scan.length} chars, ${candidates.length} candidates (cap ${candidateCap(scan.length)})`
    );
    fresh = candidates.length ? await askFixes(pool, candidates, reportNow, signal) : [];
  } catch (err) {
    if (signal && signal.aborted) throw err;
    // Name correction is a refinement step: the report is already valid without it,
    // so a slow or failing LLM must not make the whole job fail.
    console.warn(`[names] job ${jobId}: correction failed (${err.message}), report kept as generated`);
  }
  const fixes = mergeFixes(fresh, supported);

  const fields = {};
  const applied = [];

  if (reportNow) {
    const r = applyFixes(reportNow, fixes);
    applied.push(...r.applied);
    // write back whenever the text changed, including when a stale fix was undone
    if (r.text !== report) fields.report = r.text;
  }

  if (data) {
    let segApplied = [];
    if (Array.isArray(data.segments)) {
      for (const seg of data.segments) {
        if (typeof seg.text !== 'string') continue;
        const r = applyFixes(seg.text, fixes);
        seg.text = r.text;
        segApplied = segApplied.concat(r.applied);
      }
    }
    const t = applyFixes(data.text || '', fixes);
    data.text = t.text;
    fs.writeFileSync(transcript.path, JSON.stringify(data, null, 2), 'utf8');
    fields.transcript = data.text;
    // segment texts are the whole transcript, so their counts add to the report's
    for (const f of segApplied) {
      const hit = applied.find((a) => norm(a.wrong) === norm(f.wrong));
      if (hit) hit.count += f.count;
      else applied.push(f);
    }
  }

  // total counts = what was just replaced + what earlier passes already replaced
  const newCounts = new Map();
  for (const a of applied) {
    const k = norm(a.wrong) + '\u0000' + norm(a.correct);
    newCounts.set(k, (newCounts.get(k) || 0) + (a.count || 0));
  }
  const record = [];
  for (const f of fixes) {
    const k = norm(f.wrong) + '\u0000' + norm(f.correct);
    const before = recorded.find((r) => norm(r.wrong) === norm(f.wrong) && norm(r.correct) === norm(f.correct));
    const count = (newCounts.get(k) || 0) + (before && !stale.includes(before) ? before.count || 0 : 0);
    if (count > 0) record.push({ wrong: f.wrong, correct: f.correct, count });
  }

  fields.name_fixes = JSON.stringify(record);
  db.updateJob(jobId, fields);

  return {
    fixes,
    applied: applied.filter((a) => a.count > 0),
    reverted: stale,
    recorded: record,
    candidates: candidates.length,
    scanned: scan.length,
    cap: candidateCap(scan.length),
    reason: fixes.length
      ? ''
      : stale.length
        ? '已撤销姓名表不再支持的修正'
        : '未发现需要修正的姓名',
  };
}

module.exports = {
  extractNames,
  seedNames,
  seedFromStreamers,
  seedFromJobs,
  askFixes,
  buildPool,
  scanCandidates,
  learnMishearings,
  candidateCap,
  validateFixes,
  applyFixes,
  correctNames,
  levenshtein,
};
