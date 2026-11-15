'use strict';
const config = require('./config');
const { sleep, httpPost, httpGet } = require('./util');

/* ---------------------------------------------------------------------------
   Context window
   The local LLM (llama.cpp / "Strata" front end) reports its real window at
   GET /props (default_generation_settings.n_ctx). config.LLM_MAX_CONTEXT is only
   a pin / fallback: when it is 0 (default) the window is detected from the server.
   --------------------------------------------------------------------------- */
const FALLBACK_CONTEXT = 16384;
const OVERHEAD_TOKENS = 1500; // system prompt + instructions
const CHUNK_TOKENS = 12000; // transcript fed to one note-taking call
const NOTE_TOKENS = 2600; // output of one note-taking call
const MAX_CONTINUATIONS = 3; // keep writing when the model hits the output cap
const OUTPUT_CEILING = 8000; // never ask for more than this in a single call
const MAX_SHARP_ITEMS = 24; // moments handed to the commentary call, spread over the stream
const MAX_HIGHLIGHTS = 20; // a highlight list longer than this is a transcript dump, not a list of moments
const MIN_HIGHLIGHTS = 5; // a highlight list shorter than this is treated as incomplete
const MAX_MERGE_SPAN = 600; // two moments folded into one entry never span more than ten minutes
const SHARP_BATCH = 8; // moments per commentary call: past ~10 items in one answer the model turns into a template list
// above this many transcript tokens a single-shot report cannot cover the whole
// stream in one answer, so the report is built section by section
const SECTION_THRESHOLD = 30000;

let detectedContext = 0;

async function llmContext() {
  if (detectedContext) return detectedContext;
  const pinned = Number(config.LLM_MAX_CONTEXT) || 0;
  if (pinned > 0) {
    detectedContext = pinned;
    return detectedContext;
  }
  const origin = String(config.LLM_BASE).replace(/\/v1\/?$/, '');
  try {
    const res = await httpGet(
      `${origin}/props`,
      { Authorization: `Bearer ${config.LLM_API_KEY}` },
      15000
    );
    if (res.status === 200) {
      const json = JSON.parse(res.text);
      const n = json?.default_generation_settings?.n_ctx || json?.n_ctx;
      if (Number.isFinite(n) && n > 2048) detectedContext = n;
    }
  } catch (e) {
    console.warn(`[report] could not read ${origin}/props: ${e.message}`);
  }
  detectedContext = detectedContext || FALLBACK_CONTEXT;
  console.log(`[report] using LLM context window of ${detectedContext} tokens`);
  return detectedContext;
}

/* ---------------------------------------------------------------------------
   Token estimate, calibrated against this server's tokenizer.
   Least-squares fit over 36 real prompts built from this pipeline's transcripts
   (mean relative error 1.6%): cjk 0.732, digit 1.472, other 0.373 tokens/char.
   Timestamps are expensive, which is why digits cost more than CJK. The values
   below are the fit rounded up slightly so a request never overflows the window.
   --------------------------------------------------------------------------- */
const TOK_CJK = 0.75;
const TOK_DIGIT = 1.5;
const TOK_OTHER = 0.4;

function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let digit = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (ch >= '\u3000' && ch <= '\u9fff') cjk++;
    else if (ch >= '\u0400' && ch <= '\u04ff') cjk++;
    else if (ch >= '0' && ch <= '9') digit++;
    else other++;
  }
  return Math.ceil(cjk * TOK_CJK + digit * TOK_DIGIT + other * TOK_OTHER);
}

/**
 * Output budget: longer streams get a longer report, but never beyond the window.
 * A report has three parts (a summary covering the whole stream, a highlight list,
 * and one comment per meme moment), so the floor is the size of those three parts
 * for a short stream, not a flat 2500 tokens. This model stops on its own around
 * 3000-3800 tokens per answer, so anything above that is reached through the
 * continuation calls in chatComplete.
 */
function outputTarget(inputTokens, ctx) {
  const room = ctx - inputTokens - OVERHEAD_TOKENS - 300;
  const want = 3000 + Math.round(inputTokens * 0.12);
  return Math.max(2000, Math.min(OUTPUT_CEILING, want, room));
}

async function chatRaw(messages, opts = {}) {
  const ctx = await llmContext();
  const promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
  const room = ctx - promptTokens - 200;
  if (room < 500) throw new Error(`prompt too long for the ${ctx} token context (${promptTokens} tokens)`);
  const maxTokens = Math.max(200, Math.min(opts.maxTokens ?? 4000, room));
  const body = {
    model: config.LLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: maxTokens,
    stream: false,
  };
  // this server thinks out loud by default and the thinking eats the completion
  // budget; extraction-style calls do not need it, so they can be told not to.
  if (opts.reasoning) body.reasoning_effort = opts.reasoning;
  const res = await httpPost(
    `${config.LLM_BASE}/chat/completions`,
    JSON.stringify(body),
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.LLM_API_KEY}`,
    },
    opts.signal,
    opts.timeoutMs || config.LLM_TIMEOUT_MS
  );
  if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${res.text.slice(0, 400)}`);
  const json = JSON.parse(res.text);
  const choice = json.choices?.[0] || {};
  return {
    content: choice.message?.content || '',
    finish: choice.finish_reason || 'stop',
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
  };
}

/** Short, single-shot call (used by the name correction and other small prompts). */
async function chat(messages, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    const res = await chatRaw(messages, opts);
    if (res.content.trim()) return res.content;
    await sleep(1500);
  }
  throw new Error('LLM returned empty content');
}

/**
 * This model loops when it is pushed past its comfortable output length: it writes
 * something sensible and then repeats one short unit until max_tokens ("不能。不能。
 * 不能。"). Collapse any unit of 2-16 characters repeated 4 or more times.
 */
function cleanDegenerate(text) {
  return String(text)
    .replace(/(.{2,16})\1{3,}/g, '$1')
    .split('\n')
    .filter((line, i, all) => !(line.trim() && line === all[i - 1]))
    .join('\n');
}

/**
 * Self-copy: the model occasionally writes the same quoted clause twice in one
 * sentence ("不是「别炫耀」而是「别炫耀不是「别炫耀」而是…"). Quoting a line and
 * then analysing it is normal, so only a second copy with nothing but connectives
 * in between is treated as a glitch.
 */
function cleanStutter(text) {
  return String(text)
    .replace(
      /(.{0,20})「([^」]{2,12})」[^，。！？\n]{0,12}「\2」/g,
      (m, pre, phrase) => `${pre}「${phrase}」`
    )
    // the same run of words written twice back to back: a generation glitch, not
    // emphasis (emphasis repeats two or three characters, never eight or more)
    .replace(/(.{8,40})\1/g, '$1');
}

/**
 * When the output cap is hit the model stops in the middle of a sentence or a
 * bullet. Drop trailing lines that are not finished so the report never ends on a
 * fragment such as "**0".
 */
const END_PUNCT = /[。！？…"'』】)|*]$/;

function trimIncompleteEnd(text) {
  const lines = String(text).split('\n');
  while (lines.length) {
    const t = lines[lines.length - 1].trim();
    if (!t) {
      lines.pop();
      continue;
    }
    if (/^#+\s/.test(t) || END_PUNCT.test(t)) break;
    lines.pop();
  }
  return lines.join('\n').trim();
}

/**
 * The report has exactly three level-2 headings. The model sometimes invents its
 * own top-level heading inside a section, which breaks the nesting on the page.
 */
function normalizeHeadings(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (!m || m[1].length === 1) return m ? `### ${m[2]}` : line;
      return line;
    })
    .join('\n');
}

/**
 * Long-form call: if the model stops because it hit max_tokens, feed back what it
 * wrote and ask it to continue, until the answer is complete or the budget is used
 * up. Returns the whole text.
 */
async function chatComplete(messages, opts = {}) {
  const target = opts.maxTokens ?? 4000;
  let out = '';
  let msgs = messages.slice();
  let callOpts = { ...opts };
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    let res;
    try {
      res = await chatRaw(msgs, { ...callOpts, maxTokens: target });
    } catch (e) {
      if (out) return trimIncompleteEnd(out);
      throw e;
    }
    const content = cleanDegenerate(res.content).trim();
    if (!content) {
      if (out) break;
      if (i >= MAX_CONTINUATIONS) throw new Error('LLM returned empty content');
      // the model occasionally spends the whole completion budget on its internal
      // reasoning and returns nothing at all; the next attempt drops the reasoning
      console.warn(`[report] empty answer from the model, retrying without internal reasoning`);
      if (callOpts.reasoning !== 'none') callOpts = { ...callOpts, reasoning: 'none' };
      await sleep(1500);
      continue;
    }
    if (out && content.length >= 80 && out.includes(content.slice(0, 80))) {
      // the model restarted from the beginning instead of continuing: appending it
      // would duplicate the section rather than finish it
      console.warn('[report] continuation repeated the text already written, stopping');
      return trimIncompleteEnd(out);
    }
    // a blank line between chunks: without it a continuation that starts with a
    // heading glues that heading onto the end of the paragraph before it
    out += '\n\n' + content;
    // The answer stopped on its own, or degenerated into a loop: nothing left to write.
    // When it hit max_tokens (finish === 'length') the text is cut off mid-sentence, so
    // it must be continued. The previous check compared characters with the token budget,
    // which is always true for Chinese output (1 token ≈ 1.3 characters), so continuation
    // never ran and every long answer ended truncated.
    if (res.finish !== 'length' || content.length < 120 || estimateTokens(out) >= target * 2) {
      return trimIncompleteEnd(out);
    }
    console.log(`[report] output truncated at ${target} tokens, continuing (${i + 1}/${MAX_CONTINUATIONS})`);
    msgs = msgs.concat([
      { role: 'assistant', content: content },
      {
        role: 'user',
        content: '上面的内容被截断了。请接着最后一句继续写，不要重复已经写过的内容，不要重新开头，直接完成剩下的部分。',
      },
    ]);
    await sleep(400);
  }
  return trimIncompleteEnd(out);
}

const SYSTEM = '你是一名专业的 VTuber 直播内容编辑，擅长观看直播录像并写出结构清晰、有趣、有观点的内容报告。点评时只调侃直播里的梗与场面，不评价主播本人，不刻薄、不人身攻击。回答使用中文，输出 Markdown。';

// 辛辣锐评 is deliberately not an objective critique: it is a theatrical, joking
// commentary on the memes and bits of this particular stream. "下头" here means
// "playing with a meme / a dirty joke / a fail that turns out funny", never a
// judgement of the streamer as a person, so the wording must stay affectionate.
const SHARP_COMMENT_RULES = `用风趣、幽默、带戏剧性的语气点评这场直播里的「梗」和「名场面」，而不是评价主播这个人：
- 「下头」指的是玩梗、整活、口嗨、黄段子、嘴硬、破防、翻车、尬到笑场这类**场面**，不是批评主播：只调侃场面和梗本身，不人身攻击，不刻薄，不贬低，不上价值，不评价主播的性格、人品或能力；
- 逐条列出这场直播里「有梗 / 有趣」的瞬间（黄段子也可以，引用时点到为止），说明发生了什么，并给出时间戳 HH:MM:SS 或引用原话；
- 对离谱、夸张、令人瞠目之处，辛辣地点评；对真诚、暖心、令人动容之处，直接表达被打动。措辞要随场面变化，不要把某一种感叹反复套用；补刀句的写法要轮换：反问、夸张、类比、弹幕反应、自嘲、下一句反转都可以，不要每条都用「这种……的荒诞」「这种……的笑点」「这种……的反差」「这本身就构成一种……」这类收尾；
- 语气像看完直播后的脱口秀式吐槽：调侃梗、捧场主播，带着善意的笑意；每一句都要基于转录中真实发生的内容，不编造、不夸大。`;

// The timeline marks stretches with no speech instead of padding them with ASR
// placeholders. Without this rule the model fills an empty window with invented events.
const SILENCE_RULE = `时间线里可能出现 \`[静默段 HH:MM 至 HH:MM 无人说话]\`：这段时间确实没有人说话。可以提一句「开播前有一段静默」，但不要编造这段时间里发生的事件；每个环节的时间区间从该环节第一段真实说话开始。`;

function reportPrompt(title, timeline, lengthTarget, banned = []) {
  return `以下是直播录像「${title}」的语音转录，每行带有 [HH:MM:SS] 时间戳。${SILENCE_RULE} 请基于转录生成一份直播内容报告，必须包含三部分：

## 一、直播内容详细总结
按时间顺序梳理直播的主要环节（开场、游戏、互动、歌/翻唱、抽奖、结尾等），写明每个环节大致发生了什么。必须覆盖从开场到结尾的全部时间，不能只挑有趣的部分。

## 二、精彩亮点 / 名场面
列出值得回看的片段，每条必须给出原始视频中的开始时间（格式 HH:MM:SS，取自时间戳）以及两句话说明（先说明发生了什么，再说明为什么值得回看）。至少列出 5 条，按时间顺序排列。

## 三、辛辣锐评
${SHARP_COMMENT_RULES}

篇幅要求：约 ${lengthTarget} 字，三部分都要完整写完，每一句都要有新信息，不要重复同一句话，结尾不能截断。锐评里每条的写法都要不同：先复述场面并引用原话，再一句补刀，相邻两条不能用相同的句式或相同的结尾。
${banned.length ? `\n上一次草稿里这些句式被反复套用，本次必须完全不用：${banned.map((b) => `「${b}」`).join('、')}。\n` : ''}

转录：
${timeline}`;
}

/** Split a timeline into chunks whose estimated size stays under maxTokens. */
function chunkByTokens(text, maxTokens) {
  const chunks = [];
  let cur = '';
  for (const rawLine of String(text).split('\n')) {
    // a single line longer than the budget (e.g. one giant paragraph) is hard-split
    const pieces = [];
    let line = rawLine;
    while (estimateTokens(line) > maxTokens) {
      const keep = Math.max(1, Math.floor(maxTokens / TOK_OTHER));
      pieces.push(line.slice(0, keep));
      line = line.slice(keep);
    }
    pieces.push(line);
    for (const piece of pieces) {
      if (cur && estimateTokens(cur + piece) > maxTokens) {
        chunks.push(cur);
        cur = piece;
      } else {
        cur += (cur ? '\n' : '') + piece;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Split a chunk into two halves at line boundaries (fallback when one call fails). */
function splitChunk(chunk) {
  const lines = String(chunk).split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [chunk];
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

/** First and last timestamp in a chunk, for the section heading. Silence markers are not
 *  events, so a chunk that opens with one is anchored at the first real utterance. */
const SILENCE_MARK_RE = /^\s*\[静默段\s/;
function chunkRange(chunk) {
  const body = String(chunk)
    .split('\n')
    .filter((l) => !SILENCE_MARK_RE.test(l))
    .join('\n');
  const times = [...body.matchAll(/(\d{1,2}):(\d{2}):(\d{2})/g)];
  if (!times.length) return null;
  const f = times[0];
  const l = times[times.length - 1];
  return { start: `${f[1]}:${f[2]}:${f[3]}`, end: `${l[1]}:${l[2]}:${l[3]}` };
}

/**
 * Notes for one time block: a chronological summary plus two machine-readable
 * lists of highlights and meme moments. Code assembles the final report from
 * these blocks, so every part of a long stream is covered.
 */
async function noteBlock(title, chunk, i, total, signal, banned = []) {
  const range = chunkRange(chunk);
  const heading = range ? `${range.start}–${range.end}` : `第 ${i} 段`;
  // blocks are generated one after another, so clichés found in earlier blocks can be
  // forbidden for the later ones instead of drifting into a house style
  const avoid = banned.length
    ? `\n前面几段已经反复用过这些句子，这一段必须完全不用：${banned.map((b) => `「${b}」`).join('、')}。`
    : '';
  const raw = await chatComplete(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `这是直播「${title}」转录的第 ${i}/${total} 段（时间范围 ${heading}，每行带 [HH:MM:SS] 时间戳）。${SILENCE_RULE} 请按下面的格式输出，只输出内容，不要客套话：

### ${heading}
按时间顺序列出这一段里实际发生的环节和事件（开场、游戏、互动、唱歌、聊天、抽奖、结尾等），每条带时间戳。每条的写法是：先写 **HH:MM:SS–HH:MM:SS：一句话标题**，再用两三句说明这段实际发生了什么，所以每一条都有标题。要覆盖整段，不要只挑有趣的部分。每条的写法要和其他段不同，不要套用同一个句式。

【名场面】
- HH:MM:SS — 一句话说明为什么值得回看

【有梗场面】
- HH:MM:SS — 一句话说明（玩梗、整活、口嗨、黄段子、嘴硬、破防、翻车、尬到笑场这类场面；只描述场面，不评价主播这个人）
${avoid}

${chunk}`,
      },
    ],
    { maxTokens: NOTE_TOKENS, signal, reasoning: 'none' }
  );
  return { heading, raw };
}

/** Pull the bullet list that follows a 【marker】 heading out of a note. */
function extractItems(note, marker) {
  const items = [];
  let inside = false;
  for (const line of String(note).split('\n')) {
    const t = line.trim();
    if (t.startsWith('【' + marker)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    // the next list starts here: without this the 有梗场面 bullets are read as
    // 名场面 items too, and the two sections end up sharing one pool
    if (t.startsWith('【')) {
      inside = false;
      continue;
    }
    if (t.startsWith('#')) {
      inside = false;
      continue;
    }
    const m = t.match(/^[-*]\s+(.*)$/) || t.match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    const time = m[1].match(/\d{1,2}:\d{2}:\d{2}/);
    const text = m[1].replace(/^\d{1,2}:\d{2}:\d{2}\s*[—–\-:]*\s*/, '').trim();
    if (time && text) items.push({ time: time[0], text });
  }
  return items;
}

/** Keep the chronological summary of a note, drop the machine-readable lists. */
function blockSummary(note) {
  const lines = [];
  for (const line of String(note).split('\n')) {
    const t = line.trim();
    if (t.startsWith('【')) break;
    // the model sometimes repeats the instruction as an intro line
    if (/^(按时间顺序|以下是|这是直播)/.test(t)) continue;
    lines.push(line);
  }
  return cleanStutter(lines.join('\n').trim());
}

function timeToSeconds(t) {
  const p = String(t).split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.time + '|' + it.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  out.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));
  return out;
}

function itemsToText(items) {
  return items.map((i) => `- ${i.time} — ${i.text}`).join('\n');
}

/**
 * The model sometimes starts a section by repeating its own title ("辛辣锐评",
 * "精彩亮点 / 名场面") or inventing a heading. The page already has the section
 * heading, so drop those lines.
 */
function stripTitleEcho(text) {
  const lines = String(text).split('\n');
  while (lines.length) {
    const t = lines[0].trim();
    if (!t) {
      lines.shift();
      continue;
    }
    if (/^#+\s/.test(t)) {
      lines.shift();
      continue;
    }
    if (/^(辛辣)?(锐评|总评|总结|概览|概述|名场面|精彩亮点|直播报告)/.test(t) && t.length <= 40) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

/** Title echo out, stray headings demoted, self-copies collapsed. */
/** A line repeated immediately after itself is a rendering artifact, not content. */
function dropRepeatLines(text) {
  const out = [];
  let last = '';
  for (const line of String(text).split('\n')) {
    if (line.trim() && out.length && line === last) continue;
    if (line.trim()) last = line;
    out.push(line);
  }
  return out.join('\n');
}

function cleanSection(text) {
  return dropRepeatLines(normalizeHeadings(cleanStutter(stripTitleEcho(text))));
}

/**
 * Spread the collected moments over the whole stream instead of sending every
 * single one: with 50 items the model writes one terse templated line each, which
 * reads like a checklist. A few dozen well-spaced moments give real commentary.
 */
function spreadItems(items, limit) {
  if (items.length <= limit) return items;
  const step = items.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/**
 * The model, when asked for a long list of commentaries, tends to latch onto one
 * comparative construction ("比任何X都更Y") and apply it to every item. Count the
 * clichés; if one dominates, the section is regenerated with that exact phrase
 * banned and the better of the two drafts is kept.
 */
const MAX_TEMPLATE_REUSE = 6; // only regenerate when a phrase really dominates: 4 was too trigger-happy
const TEMPLATE_RE = /比任何[^，。\n]{0,40}|太[\u4e00-\u9fff]{2,3}了/g;

/**
 * Templates where only the filler changes ("比任何悬疑剧都更荒诞", "比任何冷笑话都更
 * 离谱") are the same construction 19 times, but no literal phrase repeats, so the
 * exact-phrase scan cannot see them. Count them as families.
 */
/**
 * `[label, regex, keep, trigger]` — `keep` is how many of that family a section may
 * still contain, `trigger` is how many occurrences make the section worth trimming.
 * Most of these are only bad when overused, so they keep the defaults; the degenerate
 * one says nothing at all, so it needs no domination to go.
 */
const TEMPLATE_FAMILIES = [
  ['比任何…都更…', /比任何[^，。\n]{0,40}都更/g],
  ['这种…的笑点/荒诞', /这种[^。\n]{0,24}(笑点|荒诞|趣味|反差|尴尬)/g],
  ['弹幕大概/估计…', /弹幕(估计|大概率|可能|肯定)[^。\n]{0,20}/g],
  ['…本身就是一种…', /本身(也是|就是|构成)[一两][种个]/g],
  ['…本身构成喜剧/荒诞…', /本身(也是|就是|构成)[^。\n]{0,14}(喜剧|荒诞|笑点|趣味)/g],
  ['不是谁在搞笑，是…', /不是谁在搞笑/g],
  ['让场面充满…', /让场面充满[^。\n]{0,16}/g],
  // the degenerate mode: a moment is "analysed" by restating its own words as a
  // paradox ("仿佛"X"是一种需要被"Y"来确认的异常行为"). Nothing about the moment is
  // said, so it is cut whenever it appears more than once.
  ['仿佛…需要被…确认的异常行为', /(?:仿佛|让整段)[^。\n]{0,60}(?:需要被|变成某种关于)[^。\n]{0,40}|本身才是正常行为/g, 1, 2],
  // a sentence that is nothing but a verdict adds no information about the moment; two
  // of them per section is emphasis, more is a tic.
  ['裸的结论句（令人X。）', /^令人[\u4e00-\u9fff]{2,3}[。.!！]*$/g, 2, 3],
  // "太X了" is the model's default exclamation. It is tacked onto a moment that has
  // already been described, so the clause is cut and the sentence around it is kept;
  // when the whole sentence is the exclamation, the sentence goes with it.
  ['太X了（口头禅）', /太[\u4e00-\u9fff]{2,3}了[，。.!！？]?/g, 4, 6, 'clause'],
  // the degenerate analysis mode, in its five shapes: a word from the quote is named an
  // "attribution" or an "image", the moment is "a confirmation of whether X", and every
  // such clause ends in "the more X the more self-doubt". None of them says anything
  // about what actually happened, so they go as soon as the pattern repeats.
  ['把X包装成Y的归因', /把[^，。\n]{0,30}包装成[^，。\n]{0,30}的归因/g, 1, 3, 'clausefull'],
  ['像一个人用…意象…描述', /像一个人用[^，。\n]{0,30}(?:意象|标签)[^，。\n]{0,30}(?:描述|合理化|解释)?[^，。\n]{0,20}/g, 1, 3, 'clausefull'],
  ['让这段…变成一场关于…的确认', /让[^，。\n]{0,20}(?:接话|描述|段落|收尾|补充)变成一场关于[^，。\n]{0,30}/g, 1, 3, 'clausefull'],
  ['越X越像自我Y', /越[\u4e00-\u9fff]{1,4}越像[\u4e00-\u9fff]{1,8}/g, 1, 3, 'clausefull'],
  ['一段关于…的即兴接话', /一段关于[^，。\n]{0,30}的(?:即兴接话|补充|收尾)/g, 1, 3, 'clausefull'],
  // the simile that explains nothing: "像一个人反复确认自己不会饿死". Only the shapes
  // that personify the moment are cut; "有点像广州的越秀" is a real comparison.
  ['像一个人/一场…（无信息类比）', /像(?:一个人|两个人|一场|这场|一段|那个)[^，。\n]{0,40}/g, 1, 3, 'clausefull'],
];

const FILLER_RE = /(?:仿佛|让整段)[^。\n]{0,60}(?:需要被|变成某种关于)|本身才是正常行为/;

/** Sentences that only perform analysis without saying anything about the moment.
 *  Split line by line, exactly like trimCliches does, so the two always agree. */
function fillerSentences(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    for (const t of splitSentences(line)) {
      if (FILLER_RE.test(t)) out.push(t);
    }
  }
  return out;
}

/** How often a family occurs in a text. A family anchored at `^` matches a whole
 *  sentence, so it cannot be counted against the raw text: only a sentence-level scan
 *  can see one of its uses. */
function familyCount(text, re) {
  const body = String(text);
  if (re.source.startsWith('^')) {
    let n = 0;
    for (const line of body.split('\n')) {
      for (const s of splitSentences(line)) {
        re.lastIndex = 0;
        if (re.test(s)) n++;
      }
    }
    return n;
  }
  return (body.match(re) || []).length;
}

function templateCounts(text) {
  const counts = new Map();
  for (const m of String(text).match(TEMPLATE_RE) || []) {
    const key = m.trim();
    if (key.length < 4) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [label, re] of TEMPLATE_FAMILIES) {
    const n = familyCount(text, re);
    if (n) counts.set(label, (counts.get(label) || 0) + n);
  }
  return counts;
}

/** Most repeated known clichés, most frequent first. */
function topTemplates(text, limit = 3) {
  return [...templateCounts(text).entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/**
 * Generic fallback: banning a known cliché is not enough, the model just finds a new
 * one ("本身构成一个…", "弹幕大概已经开始…"). Any CJK phrase of 6-12 characters that
 * shows up MAX_TEMPLATE_REUSE times is treated as a template. Overlapping windows of
 * the same run collapse to the longest one, and the count is how often that longest
 * form actually appears ("完全经不起推敲" is one phrase, not seven shifted windows).
 */
function repeatedPhrases(text, min = 6, max = 12, atLeast = MAX_TEMPLATE_REUSE) {
  const s = String(text);
  const windows = new Map(); // phrase -> start positions
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      let ok = true;
      for (let k = 0; k < n; k++) {
        const c = g.charCodeAt(k);
        if (c < 0x4e00 || c > 0x9fff) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!windows.has(g)) windows.set(g, []);
      windows.get(g).push(i);
    }
  }
  const frequent = [...windows.entries()].filter(([, pos]) => pos.length >= atLeast);

  // windows whose occurrences overlap are the same phrase shifted by one character:
  // group them and report each run once, in its longest form
  const groups = [];
  for (const [g, pos] of frequent) {
    let group = null;
    for (const other of groups) {
      if (pos.some((p) => other.positions.some((q) => Math.abs(p - q) < max))) { group = other; break; }
    }
    if (!group) {
      group = { phrase: g, positions: [] };
      groups.push(group);
    }
    group.positions.push(...pos);
    if (g.length > group.phrase.length) group.phrase = g;
  }
  return groups
    .map((g) => [g.phrase, (windows.get(g.phrase) || []).length])
    .filter(([, c]) => c >= atLeast)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Every construction the draft leans on too often: the known clichés plus any
 * repeated phrase the model invented instead. Phrases that occur verbatim in the
 * prompt (names, quotes from the transcript) are not templates, they are content.
 */
function badTemplates(text, source = '', min = MAX_TEMPLATE_REUSE) {
  const out = [];
  for (const [p, n] of topTemplates(text, 3)) if (n >= min) out.push([p, n]);
  for (const [p, n] of repeatedPhrases(text, 6, 12, min)) {
    if (source.includes(p)) continue;
    out.push([p, n]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 3);
}

function worstReuse(text, source = '') {
  const bad = badTemplates(text, source);
  return bad.length ? bad[0][1] : 0;
}

/**
 * Drift only shows up across calls: a phrase used twice in block 1 and twice in block
 * 2 is a template even though no single answer repeats it. `counts` accumulates the
 * occurrences seen so far; the returned phrases are the ones already over the limit
 * and must not be used again.
 */
const DRIFT_THRESHOLD = 5; // ban a phrase across batches only after it has really settled in

function collectDrift(text, source, counts, limit = 12) {
  for (const [p, n] of badTemplates(text, source, 2)) {
    counts.set(p, (counts.get(p) || 0) + n);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= DRIFT_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
    .slice(0, limit);
}

/**
 * A family construction ("这种…的荒诞") cannot be banned in a prompt: the model just
 * rephrases it. Because the sharp section is written batch by batch, one use per batch
 * adds up to a section-wide tic that no single batch ever notices. When it really
 * dominates, keep the first CLICHE_KEEP uses and drop the sentence that repeats it --
 * only sentences that are not the whole item, so no moment is lost.
 */
const CLICHE_KEEP = MAX_TEMPLATE_REUSE;
const CLICHE_TRIGGER = 8; // only cut when a family really dominates the section

/**
 * Sentences, but never cut inside a quote. The model quotes whole utterances, and the
 * period that closes one is part of the quote, not a boundary: splitting there leaves a
 * dangling fragment behind when the rest of the sentence is trimmed. The same holds for
 * a parenthetical ("（绝配？绝育？）"): cutting it in half leaves a lone closing bracket,
 * which then looks like a typo once the filler around it is gone.
 */
function splitSentences(line) {
  const out = [];
  let buf = '';
  let open = false;
  let depth = 0;
  for (const ch of String(line)) {
    buf += ch;
    // ASCII quotes are used for both opening and closing in these reports, so they
    // have to toggle; the curly ones are unambiguous.
    if (ch === '"') open = !open;
    else if (ch === '\u201C' || ch === '\u300C') open = true;
    else if (ch === '\u201D' || ch === '\u300D') open = false;
    else if (ch === '(' || ch === '（') depth++;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    else if (!open && depth === 0 && /[。！？]/.test(ch)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Whether the character at `pos` sits inside a quoted utterance. The streamer's own
 *  words are content, not the model's tic, so a clause cut must never reach into them. */
function inQuote(text, pos) {
  let open = false;
  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (ch === '"') open = !open;
    else if (ch === '\u201C' || ch === '\u300C') open = true;
    else if (ch === '\u201D' || ch === '\u300D') open = false;
  }
  return open;
}

/**
 * The comma-delimited runs of a sentence, never cut inside a quote or a parenthetical.
 * Each part carries the separator that follows it, so dropping one part leaves the rest
 * punctuated the way it was. Used for tics that are not a phrase but a whole clause:
 * "而「X」的重复让这段接话变成一场关于「是否Y」的确认" is not worth keeping in pieces.
 */
function splitClauses(line) {
  const out = [];
  let buf = '';
  let open = false;
  let depth = 0;
  for (const ch of String(line)) {
    if (!open && depth === 0 && /[，,；;—–]/.test(ch)) {
      if (buf.trim()) out.push({ text: buf, sep: ch });
      buf = '';
      continue;
    }
    buf += ch;
    if (ch === '"') open = !open;
    else if (ch === '\u201C' || ch === '\u300C') open = true;
    else if (ch === '\u201D' || ch === '\u300D') open = false;
    else if (ch === '(' || ch === '（') depth++;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
  }
  if (buf.trim()) out.push({ text: buf, sep: '' });
  return out;
}

/** A clause left behind by a cut: a quoted phrase plus a nominal suffix and nothing
 *  said about it ("「我的」的重复", "「挂脖的这样还就是」这句"). There is no predicate
 *  here, only a quote with connective tissue stapled to it, so it goes with the clause
 *  that was cut. */
function isFragmentClause(text) {
  const core = String(text)
    .replace(/"[^"]*"|\u201C[^\u201D]\u201D|\u300C[^\u300D]\u300D/g, '')
    .replace(/^(?:而|且|但|也|同时|更|甚至|还有|此外|并且|不过)\s*/, '');
  if (!core.trim()) return false;
  const rest = core
    .replace(/(?:的(?:重复|补充|对比|接话|描述|确认|延伸|铺垫|收尾|强化|循环|独白|谈判|拉锯|类比|自嘲|情绪|反应|追问|强调|否定|反驳|自辩|解释|呼应|对照|落点)|这句|这句话|这个(?:措辞|表达|行为|动作|场景|细节)|本身)/g, '')
    .replace(/[和与而及的]/g, '');
  return !/[\u4e00-\u9fff]/.test(rest);
}

/** A sentence that had a clause cut out of it still has to read as one: no doubled
 *  period where a quote was the only thing removed, no dangling conjunction left at
 *  the front, nothing that is only connective tissue. */
function repairSentence(s) {
  // a sentence never starts with a comma: one is left behind when a clause that
  // repeated the heading title is cut out of the front of a paragraph
  let out = s.replace(/^\s*[,，;；、]+/, '');
  out = out.replace(/([。！？])(["\u201D])[。！？]/g, '$1$2');
  // a run of cut clauses can leave only connective tissue at the front ("但也——…"),
  // so peel conjunctions off until the sentence starts with something real
  let prev;
  do {
    prev = out;
    out = out.replace(/^(?:也|但|而且|并且|不过|同时|更|甚至|还有)[，,;；—–-]*\s*/, '');
  } while (out !== prev);
  out = out.replace(/[，,;；—–-]+\s*$/, '');
  // two cuts next to each other leave "，，" or "，。" where a clause used to be
  out = out.replace(/[，,;；]{2,}/g, '，').replace(/[，,;；—–]([。！？])/g, '$1');
  const core = out.replace(/[^0-9a-zA-Z\u4e00-\u9fff]/g, '');
  if (!core) return '';
  // a quote that already ends inside itself is a complete sentence; adding another
  // period after the closing quote is the "。"." artifact the model then repeats
  const quoteEndsTerminal = /["\u201D]$/.test(out) && /[。！？]["\u201D]$/.test(out);
  if (!/[。！？…]$/.test(out) && !quoteEndsTerminal) out += '。';
  return out;
}

function trimCliches(text, quiet = false) {
  const body = String(text);
  // a family is only worth cutting once it actually dominates the section; the
  // degenerate one has its own lower trigger because it says nothing
  const active = TEMPLATE_FAMILIES.filter(([, re, , trigger = CLICHE_TRIGGER]) => familyCount(body, re) >= trigger);

  const counts = new Map();
  const out = [];
  let dropped = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^#+/.test(t) || /^[-=]+$/.test(t)) {
      out.push(line);
      continue;
    }
    const kept = [];
    for (const s of splitSentences(t)) {
      let cur = s;
      let cut = false;
      // a clause family cuts the tic out of the middle of a sentence; the sentence
      // itself still says something, so it survives. A "clausefull" family is the
      // sentence's only content, so the whole comma-delimited run goes with it.
      for (const [label, re, allow = CLICHE_KEEP, , mode] of active) {
        if (mode !== 'clause' && mode !== 'clausefull') continue;
        if (mode === 'clausefull') {
          const parts = [];
          for (const p of splitClauses(cur)) {
            re.lastIndex = 0;
            const m = re.exec(p.text);
            if (m && !inQuote(p.text, m.index)) {
              const n = counts.get(label) || 0;
              if (n < allow) {
                counts.set(label, n + 1);
                parts.push(p);
                continue;
              }
              dropped++;
              cut = true;
              continue;
            }
            parts.push(p);
          }
          cur = parts.map((p) => p.text + p.sep).join('');
          continue;
        }
        cur = cur.replace(re, (m, offset) => {
          if (inQuote(cur, offset)) return m;
          const n = counts.get(label) || 0;
          if (n < allow) {
            counts.set(label, n + 1);
            return m;
          }
          dropped++;
          cut = true;
          return '';
        });
      }
      // these regexes are global, so .test() is stateful: reset before each sentence
      const family = active.find(([, re, , , mode]) => {
        if (mode === 'clause') return false;
        re.lastIndex = 0;
        return re.test(cur);
      });
      if (family) {
        const allow = family[2] ?? CLICHE_KEEP;
        const n = counts.get(family[0]) || 0;
        if (n >= allow) {
          dropped++;
          continue;
        }
        counts.set(family[0], n + 1);
      }
      // a cut leaves behind a clause that is only a quote with a nominal suffix stapled
      // to it ("「我的」的重复"): no predicate, nothing said. The quote itself is already
      // in the sentence's opening list, so the fragment goes with the clause it belonged to.
      // Headings are skipped: the closing "**" is attached to the last clause, so cutting
      // one off there would leave the markup unbalanced.
      if (!/^\*/.test(cur)) {
        const parts = splitClauses(cur);
        const whole = parts.filter((p) => !isFragmentClause(p.text));
        if (whole.length !== parts.length) {
          cut = true;
          cur = whole.map((p) => p.text + p.sep).join('');
        }
      }
      // a sentence that lost its middle still has to read as one. A bold heading is
      // not a sentence, so it is left alone: adding a period there makes the next
      // pass read it as text after the heading and grow the markup.
      if (cut && !/^\*\*/.test(cur)) cur = repairSentence(cur);
      if (cur) kept.push(cur);
    }
    if (kept.length) out.push(kept.join(''));
  }
  if (dropped && !quiet) console.warn(`[report] trimmed ${dropped} filler clauses or sentences`);
  return out.join('\n');
}

/**
 * A retry is a second draft of the same material, so `diversify` keeps the draft with
 * less repetition. The discarded draft can still contain moments the kept draft never
 * mentioned, and losing those moments is worse than one extra repetitive sentence:
 * merge by timestamp (chronological order) so nothing collected is thrown away.
 * Only timestamped items are merged, prose paragraphs are left untouched.
 */
const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})/;

/** A timestamp with or without seconds. Greedy on the seconds so `12:34:56` is read as
 *  one time rather than as `12:34` followed by `34:56`. */
const TIMEISH_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function toSeconds(m) {
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Splits a draft into items: a timestamp line plus the lines that belong to it. */
function splitItems(text) {
  const items = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(TIME_RE);
    if (m) {
      if (cur) items.push(cur);
      cur = { sec: toSeconds(m), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      items.push({ sec: -1, lines: [line] });
    }
  }
  if (cur) items.push(cur);
  return items;
}

function mergeDrafts(kept, extra, banned = []) {
  const a = splitItems(kept);
  const seen = new Set(a.map((it) => it.sec).filter((s) => s >= 0));
  const add = splitItems(extra).filter((it) => {
    if (it.sec < 0 || seen.has(it.sec)) return false;
    const text = it.lines.join('\n');
    // an item that itself leans on a cliché we already tried to ban is not worth
    // the duplication; anything else is content we would otherwise lose
    for (const p of banned) if (text.includes(p)) return false;
    return true;
  });
  if (!add.length) return kept;
  console.log(`[report] merged ${add.length} moments from the discarded draft`);
  return [...a, ...add]
    .sort((x, y) => {
      if (x.sec < 0) return y.sec < 0 ? 0 : -1;
      if (y.sec < 0) return 1;
      return x.sec - y.sec;
    })
    .map((it) => it.lines.join('\n'))
    .join('\n');
}

/**
 * promptOf(bannedPhrases) -> user prompt. Generate once, and if the draft leans on
 * one template too heavily, try again with those templates explicitly forbidden and
 * keep the least repetitive draft (up to MAX_RETRIES attempts).
 */
const MAX_RETRIES = 1; // one regeneration is enough; more attempts cost time and rarely help

async function diversify(promptOf, maxTokens, signal) {
  let bestPrompt = promptOf([]);
  let best = cleanSection(await chatComplete([{ role: 'system', content: SYSTEM }, { role: 'user', content: bestPrompt }], { maxTokens, signal }));
  let bestScore = worstReuse(best, bestPrompt);
  const banned = [];

  for (let attempt = 0; attempt < MAX_RETRIES && bestScore >= MAX_TEMPLATE_REUSE; attempt++) {
    const bad = badTemplates(best, bestPrompt);
    if (!bad.length) break;
    for (const [p] of bad) if (!banned.includes(p)) banned.push(p);
    console.warn(`[report] repetitive phrasing (${bad.map(([p, n]) => `${p} ×${n}`).join(', ')}), retrying with those patterns banned (${attempt + 1}/${MAX_RETRIES})`);
    try {
      const prompt = promptOf(banned);
      const draft = cleanSection(await chatComplete([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens, signal }));
      const score = worstReuse(draft, prompt);
      if (score < bestScore || (score === bestScore && draft.length > best.length)) {
        best = draft;
        bestPrompt = prompt;
        bestScore = score;
      } else {
        // the retry is not better, but it may cover moments the kept draft missed:
        // merge them in rather than throwing the whole attempt away
        best = mergeDrafts(best, draft, banned);
      }
    } catch (e) {
      console.warn(`[report] retry failed: ${e.message}`);
    }
  }
  return best;
}

/* ---------------------------------------------------------------------------
   Completeness of a single-shot report
   One answer can run out of budget before the third section, or stop describing
   the stream halfway through. Both are detectable from the text: the section
   headings are missing, or the last timestamps of the transcript never appear.
   Whatever is missing is asked for separately and appended, so a report never
   ends with two of the three sections or only covers the first hour.
   --------------------------------------------------------------------------- */

function sectionKey(line) {
  const t = line.trim();
  if (!t || t.length > 80) return null;
  if (!/^(?:#{1,4}\s*|\*\*)?\s*(一|二|三)[、.．]/.test(t)) return null;
  if (/总结|概览|梳理/.test(t)) return 'summary';
  if (/亮点|名场面|精彩/.test(t)) return 'highlights';
  if (/锐评|点评|吐槽/.test(t)) return 'sharp';
  return null;
}

/** Split a report into intro + three sections so the missing parts can be filled in.
 * Every occurrence of a section heading is a boundary: a continuation often re-emits
 * the heading it already wrote, and keeping only the first one swallows the rest of
 * the report into the section that started earlier. */
function reportSections(text) {
  const lines = String(text).split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const key = sectionKey(lines[i]);
    if (key) starts.push({ key, i });
  }
  const out = { intro: '', summary: '', highlights: '', sharp: '' };
  if (!starts.length) {
    // no headings at all: treat everything as prose about the stream and let the
    // two structured sections be generated from it
    out.summary = String(text).trim();
    return out;
  }
  starts.sort((a, b) => a.i - b.i);
  out.intro = lines.slice(0, starts[0].i).join('\n').trim();
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    const chunk = lines.slice(starts[k].i + 1, end).join('\n').trim();
    if (!chunk) continue;
    out[starts[k].key] = out[starts[k].key] ? out[starts[k].key] + '\n\n' + chunk : chunk;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Final assembly
   ---------------------------------------------------------------------------
   The structure the model produces is not trustworthy: a continuation re-emits a
   heading it already wrote, a chronological summary drifts into a numbered list,
   and one moment gets described twice in two different formats. The finished report
   is therefore re-split at every section heading, each block is classified by what
   it looks like, blocks describing the same moment are merged, clauses that repeat
   themselves inside one paragraph are collapsed, and the two lists are numbered in
   order. All of this is plain string handling, no model calls.
   --------------------------------------------------------------------------- */

const SECTION_TITLES = {
  summary: '## 一、直播内容详细总结',
  highlights: '## 二、精彩亮点 / 名场面',
  sharp: '## 三、辛辣锐评',
};
const SECTION_ORDER = ['summary', 'highlights', 'sharp'];

/** The junk models put in front of a timestamp: bullets, bold markers, list numbers,
 *  in any order (`1. **[01:14]` and `**1. [01:14]` are the same item). */
const LIST_PREFIX = '(?:[-*+•]|\\d+[.、)]|\\s)*';

/** A line that opens a list item: bold, bulleted, or a number followed by a timestamp.
 *  The seconds are optional: the model sometimes writes a moment as `[01:14]`, which
 *  means 01:14:00 in the same scale as the rest of the report. */
const ITEM_RE = new RegExp('^' + LIST_PREFIX + '\\[?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?');

/** "00:43:05–01:27:29" anywhere, with or without parentheses. */
const TIMESPAN_RE = /\d{1,2}:\d{2}:\d{2}\s*(?:[-–—~]|至|到)\s*\d{1,2}:\d{2}:\d{2}/;

/** The same span written without seconds, e.g. a chunk heading "（00:00–00:05）". */
const SHORT_SPAN_RE = /\d{1,2}:\d{2}\s*(?:[-–—~]|至|到)\s*\d{1,2}:\d{2}/;

/** A lone timestamp plus the markdown junk around it, e.g. `**12. [01:37:03] – **：`. */
const STAMP_RE =
  new RegExp(
    '^' + LIST_PREFIX + '\\[?\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\]?\\s*(?:[-–—~]\\s*)?\\*{0,2}\\s*[：:]?'
  );

/** A heading that is nothing but a timestamp: `**00:05:26–00:06:57**`. Such a heading
 *  is worth a title, which can be derived from its own body without the LLM. */
const BARE_STAMP_RE =
  new RegExp(
    '^' + LIST_PREFIX + '\\[?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*\\]?\\s*(?:[-–—~]\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?\\*{0,2}$'
  );

/**
 * A heading the model leaves half open: `**00:02:55 "声音像AI吗"**—调完参数后主播
 * 自己评价"声音像AI"**`. The line is one heading with an extra bold run in the
 * middle, so the last `**` has nothing to pair with and shows up as literal text.
 * The wording is all heading, so closing it as a single run keeps the content and
 * makes the report stable when it is normalised again.
 */
function balanceBold(line) {
  const t = String(line);
  const runs = t.match(/\*+/g);
  if (!runs || runs.length < 3 || runs.length % 2 === 0) return line;
  if (!t.startsWith('*') || !t.endsWith('*')) return line;
  const inner = t
    .slice(runs[0].length, t.length - runs[runs.length - 1].length)
    .replace(/\*+/g, '')
    .trim();
  if (!inner) return line;
  return runs[0] + inner + runs[runs.length - 1];
}

/** One block per heading, per item, per paragraph. */
function splitBlocks(text) {
  const blocks = [];
  let open = null;
  for (const line of String(text).split('\n')) {
    const t = balanceBold(line.trim());
    if (!t || /^[-=]+$/.test(t)) {
      if (open && open.body.length && open.body[open.body.length - 1] !== '') open.body.push('');
      continue;
    }
    const key = sectionKey(t);
    if (key) {
      blocks.push({ type: 'section', key, head: '', body: [] });
      open = null;
      continue;
    }
    if (/^#{1,6}\s/.test(t)) {
      // a heading that is nothing but a time range is the note-block marker the model
      // copied in; it carries no content, so it would only leave an empty heading
      const bare = t.replace(/^#+\s*/, '').trim();
      if (/^\d{1,2}:\d{2}:\d{2}\s*(?:[-–—~]|至|到)\s*\d{1,2}:\d{2}:\d{2}$/.test(bare)) {
        open = null;
        continue;
      }
      // a heading carrying a time window is a step of the chronological summary, not
      // free prose: turning it into a list item keeps the window (and the prose that
      // follows becomes its body) instead of leaving a loose `###` heading that never
      // gets a section title around it
      const span = bare.match(TIMESPAN_RE) || bare.match(SHORT_SPAN_RE);
      if (span) {
        const title = cleanTail(bare.replace(span[0], ''));
        blocks.push({ type: 'item', key: null, head: span[0], body: [span[0], title] });
        open = blocks[blocks.length - 1];
        continue;
      }
      blocks.push({ type: 'heading', key: null, head: t, body: [] });
      open = blocks[blocks.length - 1];
      continue;
    }
    // an old note template's markdown table row is a list item in disguise:
    // `| **00:02:52** | what happened | why it is worth watching |`
    if (/^\|/.test(t)) {
      if (/^[\s|:\-]+$/.test(t)) continue; // separator row
      const cells = t
        .replace(/^\|+/, '')
        .replace(/\|+$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      const timeCell = cells.find((c) => TIME_RE.test(c));
      if (!timeCell) continue; // header row: `| 时间 | 名场面 | 为什么精彩 |`
      const span = timeCell.match(TIMESPAN_RE) || timeCell.match(SHORT_SPAN_RE);
      const head = span ? span[0] : timeCell.match(TIME_RE)[0];
      const rest = cells.filter((c) => c !== timeCell).map((c) => cleanTail(c)).filter(Boolean);
      blocks.push({ type: 'item', key: null, head, body: [head, ...rest] });
      open = blocks[blocks.length - 1];
      continue;
    }
    // a line that is entirely bold, or entirely a timestamp, is a list item: the model
    // writes one item per line even when it forgets the time. An untimed item is not
    // dropped - renderBlocks gives it the time its position in the list implies.
    // A numbered line with a stamp anywhere is an item too: models sometimes put the
    // time at the end of the heading rather than at the front of it.
    if (ITEM_RE.test(t) || /^\*+[^*]+\*+$/.test(t) || (/^\**\s*\d+[.、)]\s/.test(t) && TIME_RE.test(t))) {
      const span = t.match(TIMESPAN_RE) || t.match(SHORT_SPAN_RE);
      const numbered = /^\**\s*\d+[.、)]\s/.test(t);
      // An unnumbered bold heading that sits wholly inside the window of the numbered
      // item above it is a sub-moment of that item, not a new entry. Left as its own
      // entry it is folded straight back into the item it came from, and the item loses
      // its own title - which is why running the assembler over its own output produced
      // a different report. Keeping the heading in the body makes the output stable.
      if (open && open.type === 'item' && open.numbered && !numbered && /^\*+[^*]+\*+$/.test(t)) {
        const own = rangeOf(open.head) || windowOf(open.head);
        const sub = windowOf(t);
        if (own && sub && sub[0] >= own[0] && (own[1] === own[0] ? true : sub[1] <= own[1])) {
          open.body.push(t);
          continue;
        }
      }
      // the timestamp is the heading only when it comes first. "**1. title** [00:06:24]"
      // is a titled item with its stamp after the title: splitting at the stamp would
      // throw the title away.
      if (span && t.slice(0, span.index).replace(/[*\s\d.、)\[-]/g, '')) {
        blocks.push({ type: 'item', key: null, head: t, body: [t], numbered });
        open = blocks[blocks.length - 1];
        continue;
      }
      // when the item text sits on the same line as its timestamp, split it off so the
      // text is not swallowed by the heading
      let head = t;
      let rest = '';
      if (span) {
        // the heading is the time range itself; everything else on the line is content
        head = span[0];
        rest = cleanTail(t.slice(span.index + span[0].length));
      } else {
        // same idea for a single timestamp: the stamp is the heading, the rest is text
        const m = t.match(STAMP_RE);
        if (m && m[0].length < t.length) {
          head = m[1];
          rest = cleanTail(t.slice(m[0].length));
        }
      }
      blocks.push({ type: 'item', key: null, head, body: rest ? [head, rest] : [head], numbered });
      open = blocks[blocks.length - 1];
      continue;
    }
    if (open && (open.type === 'item' || open.type === 'para')) open.body.push(t);
    else {
      blocks.push({ type: 'para', key: null, head: '', body: [t] });
      open = blocks[blocks.length - 1];
    }
  }
  return blocks;
}

/** First timestamp in a text, or -1 when there is none. Abbreviated stamps such as
 *  `[01:14]` count as `01:14:00`, which is how the model means them. */
function firstTime(text) {
  const m = String(text).match(TIMEISH_RE);
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0);
}

function timeSet(text) {
  return new Set([...String(text).matchAll(/(\d{1,2}):(\d{2}):(\d{2})/g)].map(toSeconds));
}

/** Letters and digits only: what a block actually says, ignoring its formatting. */
function normChars(s) {
  return String(s).replace(/[^0-9a-zA-Z\u4e00-\u9fff]/g, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** How much of the shorter text is contained in the longer one (0..1). */
function containment(a, b) {
  const A = bigrams(normChars(a));
  const B = bigrams(normChars(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

// only an explicit "worth rewatching" claim promotes an item into the highlight list.
// the bare word 「名场面」 appears in 锐评 wording far too often to be a signal: with
// it in the pattern, commentary entries were pulled into section 二 and the count there
// doubled while section 三 lost half of its items.
const WATCH_RE = /值得(反复|回看|再看|重温|重看)|反复回看|百看不厌|值得刷|值得反复看/;
const RANGE_RE = /[（(]\s*\d{1,2}:\d{2}:\d{2}\s*(?:[-–—~]|至|到)\s*\d{1,2}:\d{2}:\d{2}\s*[）)]/;
const COMMENT_RE =
  /(荒诞|荒谬|笑点|反差|喜剧|讽刺|令人|真实感|尬|嘴硬|破防|翻车|这就是|补刀|幽默|忍俊不禁|自嘲|口嗨|整活|玩梗|无厘头|突兀|落差|滑稽|戏剧|张力|代入|生动|具象化|自相矛盾|来回横跳)/;
/**
 * A real 补刀 has a rhetorical device in it: a question, an em-dash twist, an
 * analogy, a "not A but B" reversal, a mock rule ("定律"), or a 弹幕 reaction.
 * Words like 「荒诞」 or 「梗」 alone are not enough — the model uses them in plain
 * descriptions of what happened, which is exactly the flatness we want to catch.
 */
const PUNCH_RE =
  /[？?]|——|这就是|所以|相当于|等于|仿佛|像[^。\n]{2,20}(一样|似的|那样)|不是[^。\n]{2,25}而是|换句话|说白了|问题在于|难怪|怪不得|定律|规律|公式|翻译|堪称|建议|不妨|看得出来|可见|接住|嘴硬|破防|翻车|下头|整活|玩梗|口嗨|自嘲|包袱|反差|离谱|太[^。\n]{1,10}了|好家伙|这比|比任何|比一切|比谁都|连[^。\n]{1,20}都能|谁都能|本身已经算|本身就是|反而制造|补刀|硬得|变成[^。\n]{0,15}(寻猫|任务|仪式|聚会|维修室)/;
/**
 * A batch where most entries are only restating what happened is not a 锐评: the
 * model writes the description it was handed and never adds the 补刀. Count how many
 * entries actually carry one so such a batch can be asked for again.
 */
const PUNCH_MIN_RATIO = 0.6;

// an entry starts at any line that carries a timestamp heading, in any of the
// shapes the model produces: `**1. [00:40:29] title**`, `**00:40:29–00:41:00：title**`
const ENTRY_HEAD_RE = /\*{0,2}\s*(?:\d+[.、)]\s*)?\[?\s*\d{1,2}:\d{2}:\d{2}/;

function itemBodies(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (ENTRY_HEAD_RE.test(line)) {
      if (cur) out.push(cur);
      cur = line;
    } else if (cur) cur += '\n' + line;
  }
  if (cur) out.push(cur);
  return out.filter((b) => b.trim());
}

function punchRatio(text) {
  const bodies = itemBodies(text);
  if (!bodies.length) return 1;
  const punched = bodies.filter((b) => PUNCH_RE.test(b)).length;
  return punched / bodies.length;
}

/** Which section a block belongs to, given the heading it was written under. */
function classifyBlock(block, current) {
  if (block.type !== 'item') return current;
  const body = block.body.join('\n');
  // a time range is a subheading of the chronological summary: no time window may be
  // pulled out of section 一, that is the part the reader checks for missing content.
  // Only applies while still in the intro or the summary: an entry the model wrote
  // under 精彩亮点 or 锐评 keeps its window, otherwise every merged highlight would be
  // dragged back into section 一.
  if ((rangeOf(block.head) || shortRangeOf(block.head)) && (current === 'intro' || current === 'summary')) return 'summary';
  // an item that explicitly says something is worth rewatching is a highlight
  if (WATCH_RE.test(body)) return 'highlights';
  // an item stays in the list it was collected for. The two lists are built from
  // different sources (【名场面】 vs 【有梗场面】), and moving an item out of its own
  // section because its wording does not match a keyword is what left 精彩亮点 with
  // two entries while 辛辣锐评 had twenty-four.
  if (current === 'highlights' || current === 'sharp') return current;
  // a timestamped moment written as commentary belongs to the 锐评
  if (TIME_RE.test(block.head) && (COMMENT_RE.test(body) || PUNCH_RE.test(body))) return 'sharp';
  // a timestamped moment with no punchline at all is just reporting: keep it in the
  // summary so no time range is lost
  if (hasTime(block.head) && current === 'intro') return 'summary';
  return current;
}

/** True when two items describe the same moment rather than two different ones. */
function sameMoment(a, b) {
  const ta = a.body.join('\n');
  const tb = b.body.join('\n');
  const c = containment(ta, tb);
  if (c >= 0.55) return true;
  // a section that got a second list appended to it repeats its own items: the
  // headings match even when the prose under them does not
  const ha = normChars(itemParts(a).title);
  const hb = normChars(itemParts(b).title);
  if (ha.length >= 6 && hb.length >= 6 && containment(ha, hb) >= 0.7) return true;
  if (c < 0.25) return false;
  // sharing a timestamp is not enough on its own: two entries can be stamped at the
  // same minute and still be about different things. Once the stamps themselves are
  // removed the prose has to substantially overlap, otherwise the "duplicate" is a
  // separate moment and folding it in would only hide it inside another item.
  const ua = normChars(stripTimes(ta));
  const ub = normChars(stripTimes(tb));
  if (!ua.length || !ub.length) return true;
  return containment(ua, ub) >= 0.5;
}

/** Does this item read like the section it ended up in? */
function fitsFormat(block, key) {
  const body = block.body.join('\n');
  if (key === 'highlights') return WATCH_RE.test(body) ? 1 : 0;
  if (key === 'sharp') return COMMENT_RE.test(body) || PUNCH_RE.test(body) ? 1 : 0;
  return 0;
}

/** How many timestamped list items a piece of section text contains. */
function countItems(text) {
  let n = 0;
  for (const b of splitBlocks(String(text))) {
    if (b.type !== 'item') continue;
    if (TIME_RE.test(b.head) || TIME_RE.test(b.body.join('\n'))) n++;
  }
  return n;
}

/** Merge items that describe the same moment, keeping the one that fits its section.
 * Items in different sections are only merged when they are near-verbatim copies:
 * 名场面 and 锐评 are written about the same moment on purpose, and treating every
 * shared timestamp as a duplicate is how the highlight list got eaten by the 锐评. */
function mergeDuplicates(groups) {
  const items = [];
  for (const key of SECTION_ORDER) {
    for (const b of groups[key]) if (b.type === 'item') items.push({ block: b, key });
  }
  const drop = new Set();
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    if (drop.has(i)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (drop.has(j)) continue;
      if (items[i].key !== items[j].key) {
        const a = normChars(items[i].block.body.join('\n'));
        const b = normChars(items[j].block.body.join('\n'));
        if (containment(a, b) < 0.75) continue;
      } else if (!sameMoment(items[i].block, items[j].block)) {
        continue;
      }
      const fi = fitsFormat(items[i].block, items[i].key);
      const fj = fitsFormat(items[j].block, items[j].key);
      const li = items[i].block.body.join('\n').length;
      const lj = items[j].block.body.join('\n').length;
      const keep = fi !== fj ? (fi > fj ? i : j) : (li >= lj ? i : j);
      const other = keep === i ? j : i;
      // the entry being dropped may still say something the kept one does not, so its
      // sentences are folded in before it goes
      const src = items[other].block;
      // folding one item into another must not erase when the dropped moment
      // happened: if it has a time of its own, different from the item it is being
      // absorbed into, its text keeps that stamp so it reads as a sub-moment
      const own = firstTime(`${src.head || ''}\n${(src.body || []).join('\n')}`);
      const into = firstTime(items[keep].block.head || '');
      const stamp = own >= 0 && own !== into ? `${formatTime(own)} ` : '';
      let stamped = false;
      for (const line of src.body) {
        if (!line.trim() || line === src.head) continue;
        const kept = keepNewSentences(items[keep].block.body, line);
        if (!kept) continue;
        if (stamp && !stamped && firstTime(kept) < 0) {
          stamped = true;
          items[keep].block.body.push(stamp + kept);
        } else {
          items[keep].block.body.push(kept);
        }
      }
      drop.add(other);
      pairs.push([items[keep].block.head, items[other].block.head]);
      if (keep === j) break;
    }
  }
  if (!drop.size) return;
  for (const idx of drop) {
    const it = items[idx];
    const at = groups[it.key].indexOf(it.block);
    if (at >= 0) groups[it.key].splice(at, 1);
  }
  if (process.env.LIKLO_DEBUG) {
    for (const [keep, gone] of pairs) console.log(`[report] duplicate: "${String(gone).slice(0, 40)}" folded into "${String(keep).slice(0, 40)}"`);
  }
  console.log(`[report] merged ${drop.size} duplicate moments`);
}

/**
 * A highlight list that turns into a transcript dump (one entry per quote, minutes
 * apart) is merged back into moments: consecutive entries close together in time
 * become one entry carrying all of their text, so nothing is lost but the list
 * stays a list of moments. The gap widens until the list fits in `cap`.
 */
function condenseItems(blocks, cap) {
  const items = blocks.filter((b) => b.type === 'item');
  let timed = [];
  const untimed = [];
  for (const b of items) {
    const r = anyRange(b);
    const t = firstTime((b.head || '') + '\n' + (b.body || []).join('\n'));
    // an entry with no stamp of its own has the time its position in the list implies
    const start = r ? r[0] : Math.max(t, blockTime(b));
    if (start >= 0) timed.push({ block: b, start, end: r ? r[1] : Math.max(t, blockTime(b)) });
    else untimed.push(b); // no timestamp and no position to infer one from
  }
  if (!timed.length) return blocks;
  timed.sort((a, b) => a.start - b.start);

  // an entry with nothing but a heading: the title is in the heading, so there is no
  // prose under it to keep
  const hasBody = (b) => itemParts(b).lines.some((l) => l.replace(/[*\s]/g, '').length > 8);

  const fold = (list, gap) => {
    const merged = [];
    for (const it of list) {
      const prev = merged[merged.length - 1];
      // an entry that is only a heading has no content of its own, so it belongs to
      // the moment next to it rather than standing as a dangling numbered line
      const bare = !hasBody(it.block);
      const near = it.start - prev?.end <= gap || (bare && it.start - prev?.end <= 600);
      // past ten minutes a group is not a moment any more, it is a stretch of the
      // stream, and folding it turns one heading into a table of contents
      const span = Math.max(prev?.end || 0, it.end) - (prev?.start ?? it.start);
      if (prev && near && span <= MAX_MERGE_SPAN) {
        prev.end = Math.max(prev.end, it.end);
        prev.blocks.push(it.block);
      } else {
        merged.push({ start: it.start, end: it.end, blocks: [it.block] });
      }
    }
    // a bare heading at the start of the list joins the moment that follows it
    for (let i = merged.length - 1; i >= 0; i--) {
      const g = merged[i];
      if (g.blocks.length > 1 || hasBody(g.blocks[0])) continue;
      const next = merged[i + 1];
      if (next && next.start - g.end <= 600 && next.end - g.start <= MAX_MERGE_SPAN) {
        next.blocks.unshift(g.blocks[0]);
        next.start = Math.min(next.start, g.start);
        next.end = Math.max(next.end, g.end);
        merged.splice(i, 1);
      }
    }
    return merged.map((g) => {
      if (g.blocks.length === 1) return { start: g.start, end: g.end, block: g.blocks[0] };
      const parts = g.blocks.map((b) => itemParts(b));
      // usually one entry of the group is the moment itself and the rest are sub-moments
      // inside its window. That entry's own heading is the title; letting the longest
      // subheading win instead makes the item's title disagree with its range, and a
      // second pass over the same text picks a different one.
      let title = '';
      for (let i = 0; i < g.blocks.length; i++) {
        const own = anyRange(g.blocks[i]);
        const raw = parts[i].title;
        if (!own || !raw || !hasWords(raw) || STUTTER_RE.test(raw)) continue;
        if (own[0] <= g.start && own[1] >= g.end && raw.length >= 10) {
          title = raw;
          break;
        }
      }
      if (!title) title = bestTitle(parts);
      const stamp = g.start === g.end ? formatTime(g.start) : `${formatTime(g.start)}–${formatTime(g.end)}`;
      const head = `**${stamp}：${title}**`;
      const lines = [];
      const subTitles = [];
      const prose = [];
      g.blocks.forEach((b, i) => {
        const p = parts[i];
        const t = firstTime((b.head || '') + '\n' + (b.body || []).join('\n'));
        // the moment whose title became the heading needs no subheading; every other
        // one keeps its own, with its own timestamp so it stays clickable
        if (p.title && containment(normChars(p.title), normChars(title)) < 0.7) {
          const dup = subTitles.some((s) => containment(normChars(p.title), normChars(s)) >= 0.7);
          if (!dup) {
            subTitles.push(p.title);
            const own = anyRange(b);
            // a sub-moment whose window is the whole group adds nothing: the heading
            // above it already carries that range
            const whole = own && own[0] === g.start && own[1] === g.end;
            // a sub-moment with no time of its own inherits the group's start: a
            // nested heading without a stamp is not clickable
            const stamp = t < 0 ? `${formatTime(g.start)} ` : own && !whole ? `${formatTime(own[0])}–${formatTime(own[1])} ` : `${formatTime(t)} `;
            lines.push(`**${stamp}${p.title}**`);
          }
        }
        // the same moment is often listed twice in a row with the same sentences;
        // only what is not already said gets through
        for (const line of p.lines) {
          const kept = keepNewSentences(prose, line);
          if (kept) {
            prose.push(kept);
            lines.push(kept);
          }
        }
      });
      return { start: g.start, end: g.end, block: { type: 'item', head, body: [head, ...lines] } };
    });
  };

  // entries whose windows overlap or begin within 15 seconds of each other are the
  // same moment, so this runs even when the list is already short
  const before = timed.length;
  timed = fold(timed, 15);
  for (let gap = 60; gap <= MAX_MERGE_SPAN && timed.length > cap; gap = Math.round(gap * 1.5)) {
    timed = fold(timed, gap);
  }
  if (timed.length === before) return blocks;
  console.log(`[report] condensed ${items.length} list entries into ${timed.length} moments`);
  return [
    ...blocks.filter((b) => b.type !== 'item' || untimed.includes(b)),
    ...timed.map((t) => t.block),
  ];
}

/**
 * Labels the note template leaves behind ("**发生了什么：** …") and nested list
 * headings ("2. **[00:29:24] …**") that end up inside a merged item. The label is
 * dropped, the text after it stays; a nested heading becomes a plain timestamp line so
 * its own moment is still there and still clickable.
 */
const NOTE_LABEL_RE =
  /^\s*(?:[-*+•]\s*)?\*\*([^*\n]{2,16}?)\*\*\s*[:：]?\s*(.*)$/;

/** A bold template label ("**总体印象：** …", "**发生了什么：** …") is scaffolding, not
 *  content: the words after it are what the reader needs. A heading is not a label - it
 *  carries a timestamp or punctuation, and a label is a bare two-to-four-word noun. */
function stripLabel(line) {
  const m = String(line).match(NOTE_LABEL_RE);
  if (!m) return line;
  const label = m[1].replace(/[:：]$/, '').trim();
  if (!label || TIME_RE.test(label) || /[.!?，—–"'“”]/.test(label)) return line;
  if (!/^[\u4e00-\u9fffA-Za-z]+$/.test(label)) return line;
  return m[2];
}
const NESTED_ITEM_RE =
  /^\s*\d+[.、)]\s*\*{0,2}\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)(?:[^\]]*\])?\s*(.*)$/;

function plainLines(lines) {
  const out = [];
  for (const raw of lines) {
    let l = stripLabel(String(raw)).trim();
    const m = l.match(NESTED_ITEM_RE);
    if (m) {
      const rest = m[2].replace(/\*+$/, '').replace(/^[:：]\s*/, '').trim();
      l = `${m[1]}${rest ? ' ' + rest : ''}`;
    }
    if (l && hasWords(l)) out.push(balanceBrackets(closeQuotes(l)));
  }
  return out;
}

/** A bare `00:33:43 标题` (or `00:33:43–00:34:10 标题`) line sitting inside an item. */
const SUB_STAMP_RE =
  new RegExp(
    '^(\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*[–—~]\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?))?[:：]?\\s+([^\\n]*)$'
  );

/**
 * A merged item is several moments that happened close together. Each of them keeps
 * its own heading, one level under the item heading, so the item reads as a list of
 * moments instead of a paragraph with loose timestamp lines in it.
 */
/** A nested heading that lost its formatting: short, no sentence punctuation, no
 *  timestamp, not a bullet. Inside an item such a line reads as a stray fragment. */
function isLooseFragment(t) {
  if (!t || t.length < 6 || t.length > 40) return false;
  if (/^[*#|\-•]/.test(t)) return false;
  if (/^\d+[.、)]/.test(t)) return false;
  if (/[:：]$/.test(t)) return false;
  if (TIME_RE.test(t)) return false;
  return isTitleLine(t);
}

function boldSubLines(lines, parentTitle, parentStart = -1) {
  const out = [];
  // a nested heading has to carry a time to be clickable; when the model wrote one
  // without a stamp the only honest time is the moment the item itself is about
  const stamp = parentStart >= 0 ? `${formatTime(parentStart)} ` : '';
  const saidLater = (text, from) => {
    for (let j = from + 1; j < lines.length; j++) {
      const n = String(lines[j]).trim().replace(/\*+/g, '');
      if (!n) continue;
      if (containment(text, n) >= 0.7) return true;
    }
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = String(raw).trim();
    if (!t || t.startsWith('#')) {
      out.push(raw);
      continue;
    }
    // the heading's own wording repeated as a body line: the heading already says it
    if (
      parentTitle &&
      normChars(t).length <= normChars(parentTitle).length + 20 &&
      containment(t, parentTitle) >= 0.7
    ) {
      continue;
    }
    const m = t.match(SUB_STAMP_RE);
    if (m) {
      const rest = cleanTitle(m[3] || '');
      if (!rest || !isTitleLine(rest)) {
        // the line is prose that happens to start with a timestamp: leave it alone
        out.push(raw);
        continue;
      }
      if (containment(normChars(rest), normChars(parentTitle)) >= 0.7) {
        // the same moment as the heading, so the heading covers it
        continue;
      }
      const span = m[2] ? `${m[1]}–${m[2]}` : m[1];
      out.push(`**${span} ${rest}**`);
      continue;
    }
    // a whole line in bold is a heading of some kind. Without a time it is a nested
    // heading that lost its stamp (the model started a second list mid-item), so it
    // gets the item's own moment instead of reading as a stray sentence
    const bold = t.match(/^\*+\s*(.+?)\s*\*+$/);
    if (bold && !/\d{1,2}:\d{2}/.test(bold[1])) {
      const inner = cleanTitle(bold[1].replace(/^\s*\d+[.、)]\s*/, ''));
      if (inner && hasWords(inner) && isTitleLine(inner) && !saidLater(inner, i)) {
        out.push(stamp ? `**${stamp}${inner}**` : `**${inner}**`);
        continue;
      }
    }
    // a short title-like line with no timestamp is a nested heading that lost its
    // stamp; making it look like one stops it reading as a stray sentence
    if (isLooseFragment(t)) {
      // unless the same moment shows up later with a real timestamp: then this is a
      // leftover copy of that heading and would only appear twice
      if (!saidLater(t, i)) out.push(stamp ? `**${stamp}${t}**` : `**${t}**`);
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * A list item split into its title and its prose, in one shape no matter how the
 * model wrote it: title in the heading, title on the first line of the body, or no
 * title at all (then the opening clause becomes one). Lines are always individual
 * strings, never a multi-line blob, so a title can never swallow the prose.
 */
/**
 * A title taken from the first clause of the body must not be repeated by the body.
 * Only the exact prefix is removed; the rest of the sentence stays.
 */
function stripTitle(lines, title) {
  if (!title || !lines.length) return lines;
  const first = String(lines[0]);
  if (!first.startsWith(title)) return lines;
  const rest = first.slice(title.length).replace(/^[:：,，;；]/, '').trim();
  if (rest) lines[0] = rest;
  else lines.shift();
  return lines;
}

/** A title has to say something: a leftover list number ("1") is not one. */
function hasWords(s) {
  return /[\u4e00-\u9fff]|[a-zA-Z]/.test(String(s || ''));
}

function itemParts(block) {
  const lines = plainLines(
    (block.type === 'item' ? block.body.slice(1) : block.body).flatMap((l) => String(l).split('\n'))
  );
  const headText = stripTimes(block.head || '')
    .replace(/\*+/g, '')
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/^[:：]+/, '')
    .trim();
  // a heading that is only the list number ("1. [00:00:43] 1") carries no title: the
  // real one is the next line, so treat it as body instead of as a title
  if (headText && headText.length <= 80 && hasWords(headText)) {
    const title = cleanTitle(headText);
    return { title, lines: stripTitle(lines, title) };
  }
  if (headText && hasWords(headText)) lines.unshift(headText);
  if (lines.length && isTitleLine(lines[0])) return { title: cleanTitle(lines[0]), lines: lines.slice(1) };
  const title = deriveTitle(lines);
  return { title, lines: stripTitle(lines, title) };
}

/**
 * Which title of a group is worth keeping. A raw transcript fragment ("这你你玩没玩过
 * 密室，啊，…") reads better as prose than as a heading, so a clean description of the
 * moment wins even when it is shorter.
 */
const STUTTER_RE = /(你你|我我|不不不|这这|啊，|嗯，|就是就是)/;

function bestTitle(parts) {
  let best = '';
  let bestScore = 0;
  for (const p of parts) {
    const raw = p && p.title;
    if (!raw || !hasWords(raw)) continue;
    let score = raw.length;
    if (/^关于/.test(raw)) score -= 6;
    if (STUTTER_RE.test(raw)) score -= 14;
    if ((raw.match(/[，,]/g) || []).length > 2) score -= 8;
    if (score > bestScore) {
      best = raw;
      bestScore = score;
    }
  }
  return best;
}

/**
 * A paragraph that keeps restating the same clause ("把一次X写成一种Y" four times)
 * is the model running out of ideas, not content. Cluster clauses that say the same
 * thing and keep at most two of them.
 */
function collapseLine(line) {
  if (line.length < 60 || line.startsWith('#') || line.startsWith('**') || line.startsWith('-')) return line;
  const parts = line.split(/(?=[，；])/);
  if (parts.length < 3) return line;
  const kept = [];
  const clusters = [];
  for (const p of parts) {
    const n = normChars(p);
    if (n.length < 12) {
      kept.push(p);
      continue;
    }
    let hit = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (containment(n, clusters[i].norm) >= 0.5) {
        hit = i;
        break;
      }
    }
    if (hit < 0) {
      clusters.push({ norm: n, count: 1 });
      kept.push(p);
    } else if (clusters[hit].count < 2) {
      clusters[hit].count++;
      kept.push(p);
    }
  }
  if (kept.length === parts.length) return line;
  let out = kept.join('');
  if (/[。！？]$/.test(line) && !/[。！？]$/.test(out)) out += '。';
  return out;
}

/**
 * The model's favourite way to pad a thought: "把一次模仿写成一种重复强调，把一次
 * 模仿写成一种'我是这里'的重复强调". Distinct observations are kept; clauses that
 * say the same thing are dropped.
 */
const REWRITE_CLAUSE_RE =
  /把[^，。；]{1,30}(?:写成|变成|解构成|叙述成|描述成|放大成|包装成|消解成|上升到|换成)[^，。；]{1,30}/g;

function collapseRewriteClauses(line) {
  const matches = [...line.matchAll(REWRITE_CLAUSE_RE)];
  if (matches.length < 2) return line;
  const kept = [matches[0]];
  const dropped = [];
  for (const m of matches.slice(1)) {
    if (kept.some((k) => containment(k[0], m[0]) >= 0.55)) dropped.push(m);
    else kept.push(m);
  }
  if (!dropped.length) return line;
  let out = line;
  for (const m of dropped.reverse()) {
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
  }
  out = out
    .replace(/(——|，|；){2,}/g, '$1')
    .replace(/([，；—])。/g, '。')
    .replace(/^[，；—]+/, '')
    .replace(/[，；—]+$/, '')
    .trim();
  return out;
}

/** A line that is only punctuation is a hole left by the cleanup above. */
function dropPunctuationLines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/^。+/, '').replace(/。{2,}/g, '。'))
    .filter((line) => !line.trim() || /[0-9a-zA-Z\u4e00-\u9fff]/.test(line))
    .join('\n');
}

function collapseRepeats(text) {
  return dropPunctuationLines(
    String(text)
      .split('\n')
      .map((line) => collapseRewriteClauses(collapseLine(line)))
      .join('\n')
  );
}

/** Start and end seconds of a "00:14:44 – 00:18:53" span, with or without brackets. */
function rangeOf(head) {
  const m = String(head).match(RANGE_RE) || String(head).match(TIMESPAN_RE);
  if (!m) return null;
  const times = [...m[0].matchAll(/(\d{1,2}):(\d{2}):(\d{2})/g)].map(toSeconds);
  if (times.length < 2) return null;
  return [Math.min(times[0], times[1]), Math.max(times[0], times[1])];
}

/** The same thing for a span written without seconds, "（00:12–00:20）" = 12–20 minutes. */
function shortRangeOf(head) {
  const m = String(head).match(SHORT_SPAN_RE);
  if (!m) return null;
  const times = [...m[0].matchAll(/(\d{1,2}):(\d{2})/g)].map((t) => Number(t[1]) * 3600 + Number(t[2]) * 60);
  if (times.length < 2) return null;
  return [Math.min(times[0], times[1]), Math.max(times[0], times[1])];
}

/** The window a heading claims: a span, or a lone stamp read as a zero-length span. */
function windowOf(line) {
  const s = String(line);
  const span = s.match(TIMESPAN_RE) || s.match(SHORT_SPAN_RE);
  if (span) return rangeOf(span[0]) || shortRangeOf(span[0]);
  const m = s.match(STAMP_RE);
  if (!m) return null;
  // the capture is the whole stamp ("01:37:03" or the abbreviated "01:37"), so
  // parsing it by groups would read the minutes as undefined and lose the window
  const parts = m[1].split(':').map(Number);
  const t = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  return [t, t];
}

/**
 * A heading that claims to cover 00:00:27–00:54:26 but whose text only ever reaches
 * 00:03:49 is a range the model carried over from a longer list entry. The content is
 * the truth, so the claimed end is pulled back to the last moment actually discussed.
 */
function clampRange(range, body) {
  if (!range) return null;
  let max = -1;
  for (const m of String(body || '').matchAll(/(\d{1,2}):(\d{2}):(\d{2})/g)) {
    const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (s > max) max = s;
  }
  if (max < 0 || max >= range[1] - 60) return range;
  return [range[0], Math.max(range[0], max)];
}

/** Any time reference in a line, full or abbreviated. */
function hasTime(text) {
  return Boolean(TIMEISH_RE.test(text) || rangeOf(text) || shortRangeOf(text));
}

/** A block's time window: from its heading first, then from its body. */
function anyRange(block) {
  const head = block.head || '';
  const body = (block.body || []).join('\n');
  return rangeOf(head) || shortRangeOf(head) || rangeOf(body) || shortRangeOf(body);
}

/** Everything in a line that is not a timestamp, a bullet, or markdown. */
function stripTimes(s) {
  return String(s)
    .replace(TIMESPAN_RE, ' ')
    .replace(/\d{1,2}:\d{2}:\d{2}/g, ' ')
    .replace(SHORT_SPAN_RE, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\*+/g, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/^[-*+•]\s*/, '')
    .replace(/^[：:—–\-]+/, '')
    .replace(/^关于\s*/, '')
    .replace(/^([「"'])(.*)\1$/, '$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A short line right after a timestamp is a title, not prose — as long as it says
 *  something. A bare number is leftover list markup. */
function isTitleLine(line) {
  const s = String(line);
  return s.length <= 60 && !/[。！？]/.test(s) && hasWords(s);
}

/**
 * The markdown junk sitting next to a timestamp. The model writes block headings as
 * `**（00:00:27–00:04:30）**` or `**[00:23:47–00:24:55] 标题**`; slicing the range off
 * leaves `）` or `]` behind, which then shows up as an empty or broken title.
 */
function cleanTail(s) {
  const t = String(s)
    .replace(/^[*\s]+/, '')
    .replace(/^[\[()（）【】\[\]「」]+/, '')
    .replace(/^[：:—–\-]+/, '')
    .replace(/\*+$/, '')
    .replace(/[\[()（）【】\[\]]+$/, '')
    .trim();
  // what is left after a timestamp is cut out is often only the list number the model
  // put inside the brackets ("[00:00:43–00:02:00] 1"). It says nothing, so it goes.
  return hasWords(t) ? t : '';
}

/** A title with the leftover punctuation around it removed, and the model's
 *  `——一个关于X的Y` tail cut off. */
function cleanTitle(s) {
  let t = String(s)
    .replace(/\*+/g, '')
    .replace(/^[\s\-—–:：.,、\[\]()（）【】]+/, '')
    .replace(/[\s\-—–:：.,、\[\]()（）【\]]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  t = t.replace(/\s*[—–-]+\s*(?:一个|一种)?关于[^，。！？]*的[^，。！？]*$/, '').trim();
  // empty parentheticals the model leaves behind, e.g. `（ / / ）`
  t = t.replace(/[（(][\s/、,.]*[)）]/g, '').trim();
  return closeQuotes(balanceBrackets(shortenTitle(t, 60)));
}

/** Keeps a title short by dropping trailing clauses rather than slicing a sentence
 *  in half. */
function shortenTitle(t, limit) {
  const s = String(t);
  if (s.length <= limit) return s;
  const parts = s.split(/[，,；;]/).map((p) => p.trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    const next = out ? out + '，' + p : p;
    if (next.length > limit) break;
    out = next;
  }
  if (!out) out = s.slice(0, limit).replace(/[,，;；]$/, '');
  return out.trim();
}

/** Pairs up quotes inside one line. A line like `主播说"……` that opens a quote and
 *  never closes it is a transcription artifact, and an unbalanced quote reads as a typo. */
function closeQuotes(t) {
  const s = String(t);
  const mate = (c) =>
    c === '"' ? '"' : c === '\u201C' ? '\u201D' : c === '\u300C' ? '\u300D' : c === '\u201D' ? '\u201C' : '\u300C';
  const isClose = (c) => c === '\u201D' || c === '\u300D';
  const stack = [];
  for (const ch of s) {
    if (ch === '"' || ch === '\u201C' || ch === '\u300C' || ch === '\u201D' || ch === '\u300D') {
      if (stack.length && stack[stack.length - 1] === mate(ch)) stack.pop();
      else stack.push(ch);
    }
  }
  if (!stack.length) return s;
  const opens = stack.filter(isClose).map(mate).join('');
  const closes = stack.filter((c) => !isClose(c)).map(mate).reverse().join('');
  return opens + s + closes;
}

function balanceQuotes(t) {
  const s = String(t);
  const q = s.match(/["\u201C\u201D\u300C\u300D]/g) || [];
  if (q.length % 2 === 0) return s;
  const last = q[q.length - 1];
  if (last === '"' || last === '\u201C' || last === '\u300C') {
    return s + (last === '"' ? '"' : last === '\u201C' ? '\u201D' : '\u300D');
  }
  const first = q[0];
  return (first === '"' ? '"' : first === '\u201D' ? '\u201C' : '\u300C') + s;
}

/** A parenthetical cut in half — by shortening, or by two list entries being merged
 *  and one of them ending inside a bracket — reads as a typo. Only the brackets that
 *  have no partner are dropped; the words inside stay. */
function balanceBrackets(t) {
  const s = String(t);
  const stack = [];
  const drop = new Set();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '（') stack.push(i);
    else if (ch === ')' || ch === '）') {
      if (stack.length) stack.pop();
      else drop.add(i);
    }
  }
  for (const i of stack) drop.add(i);
  if (!drop.size) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) if (!drop.has(i)) out += s[i];
  return out.trim();
}

/** No title was written: take the opening of the body, one clause or two, so every
 *  item in a list is shaped the same way. The body itself is kept untouched. */
function deriveTitle(lines) {
  for (const line of lines) {
    const s = String(line).replace(/^\*+/, '').trim();
    if (!s || !hasWords(s)) continue;
    const parts = s
      .split(/[，,；;。！？]/)
      .map((p) => p.replace(/^[\[\]()（）【】]+|[\[\]()（）【\]]+$/g, '').trim())
      .filter((p) => p && !/^[0-9:：\-–.]+$/.test(p));
    if (!parts.length) continue;
    let cut = parts[0];
    for (const p of parts.slice(1)) {
      if (cut.length >= 12) break;
      cut += '，' + p;
    }
    cut = cut.replace(/[（(][\s/、,.]*[)）]/g, '').trim();
    cut = balanceQuotes(balanceBrackets(cut.slice(0, 50))).trim();
    if (cut.length >= 2) return cut;
  }
  return '';
}

/**
 * A list item rewritten in one consistent shape: a heading carrying its time range
 * and title, then the prose. Nothing is dropped: when the model wrote no title, one
 * is taken from the first clause of the body so the list never mixes titled and
 * untitled entries.
 */
/**
 * A list entry back into the canonical form: `**N. [HH:MM:SS] title**` plus its
 * paragraphs. `fallbackSec` is the moment of the entry before it: an entry the model
 * wrote without any time is about the same stretch of the stream, so inheriting that
 * time keeps the list navigable rather than dropping the entry or leaving a heading
 * with nothing to click.
 */
/**
 * A nested heading with nothing under it is not a heading: it is a moment the model
 * named and then never described. Kept as plain text the moment is still in the
 * report and its timestamp is still clickable, but the reader never sees an empty
 * heading. Only applied when the item already has prose - an item that is nothing but
 * a list of moments is a list of headings, and that is what it should stay.
 */
/** A paragraph never opens with a comma; one is left behind when a clause that
 *  repeated the heading title is cut out of the front of it. */
function trimLeadPunct(line) {
  return String(line).replace(/^\s*[,，;；、]+/, '');
}

function isHeadingLine(l) {
  const t = String(l).trim();
  return /^\*+\s*[^*]+\*+$/.test(t);
}

/**
 * A heading with nothing under it becomes prose. Prose describes a moment from its
 * beginning, so a span written in a heading is reduced to its start: a plain line
 * carrying `HH:MM:SS–HH:MM:SS` reads as a stray fragment when the sentences are
 * split, and on the next pass it would be re-parsed as an item starting at the end
 * of the span, moving the moment out of order.
 */
function demoteHeading(line) {
  const t = String(line).replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—-]\s*\d{1,2}:\d{2}(?::\d{2})?(?=[ 　]|$)/);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  return rest ? `${m[1]} ${rest}` : m[1];
}

function dropEmptyHeadings(body) {
  const hasProse = body.some((l) => !isHeadingLine(l) && String(l).trim());
  if (!hasProse) return body;
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const t = String(body[i]).trim();
    if (!isHeadingLine(t) || !/\d{1,2}:\d{2}/.test(t)) {
      out.push(body[i]);
      continue;
    }
    let j = i + 1;
    while (j < body.length && !String(body[j]).trim()) j++;
    const followed = j < body.length && !isHeadingLine(body[j]);
    if (followed) out.push(body[i]);
    else out.push(demoteHeading(t));
  }
  return out;
}

function cleanItem(block, number, fallbackSec = -1, nextStart = -1) {
  const { title, lines } = itemParts(block);
  let range =
    rangeOf(block.head) || rangeOf(block.body.join('\n')) || shortRangeOf(block.head) || shortRangeOf(block.body.join('\n'));
  let t = firstTime(block.head + '\n' + block.body.join('\n'));
  if (t < 0 && !range) {
    if (fallbackSec < 0) return null;
    t = fallbackSec;
  }
  const body = dropEmptyHeadings(boldSubLines(lines, title, range ? range[0] : t))
    .map(trimLeadPunct)
    .filter((l) => String(l).trim());
  range = clampRange(range, body.join('\n'));
  // entries are ordered by time, so one cannot claim to cover a moment the next one
  // is already about: a span that runs past its neighbour is a carried-over range
  if (range && nextStart > range[0] && range[1] >= nextStart) range = [range[0], Math.max(range[0], nextStart - 1)];
  // a range that collapsed to one instant is a single moment, not a span
  const stamp = range && range[0] === range[1] ? formatTime(range[0]) : range ? `${formatTime(range[0])}–${formatTime(range[1])}` : formatTime(t);
  const head =
    number != null
      ? `**${number}. [${stamp}]${title ? ' ' + title : ''}**`
      : `**${stamp}${title ? '：' + title : ''}**`;
  // paragraphs stay paragraphs: an item whose subheadings and prose run together on
  // consecutive lines is a wall of text
  return head + (body.length ? '\n\n' + body.join('\n\n') : '');
}

/**
 * Merge a paragraph into a block that already covers the same window, sentence by
 * sentence. The model often writes a short summary of a window and then the detailed
 * version of it; dropping the whole paragraph would take away details that only
 * appear in it, so only sentences already covered are removed.
 */
function keepNewSentences(body, line) {
  const text = String(line).trim();
  if (!text) return '';
  const hay = body.join(' ');
  const kept = text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => {
      const n = normChars(s);
      if (n.length < 6) return true;
      return containment(hay, s) < 0.6;
    })
    .join('');
  return kept.trim();
}

/** Two blocks describing the same time window are one block, not two. */
function mergeSummaryBlocks(blocks) {
  const out = [];
  let merged = 0;
  for (const b of blocks) {
    if (b.type !== 'item') {
      out.push(b);
      continue;
    }
    const r = anyRange(b);
    if (!r) {
      out.push(b);
      continue;
    }
    let joined = false;
    for (const prev of out) {
      const pr = anyRange(prev);
      if (!pr) continue;
      const overlap = Math.min(r[1], pr[1]) - Math.max(r[0], pr[0]);
      const shorter = Math.min(r[1] - r[0], pr[1] - pr[0]);
      const longer = Math.max(r[1] - r[0], pr[1] - pr[0]);
      // only blocks that describe roughly the same window, not a narrow one
      // sitting inside a broad one, are the same block twice
      if (shorter <= 0 || overlap / shorter < 0.6 || overlap / longer < 0.6) continue;
      for (const line of b.body) {
        if (!line.trim() || line === b.head) continue;
        const kept = keepNewSentences(prev.body, line);
        if (kept) prev.body.push(kept);
      }
      joined = true;
      merged++;
      break;
    }
    if (!joined) out.push(b);
  }
  if (merged) console.log(`[report] merged ${merged} overlapping summary blocks`);
  return out;
}

/** A block as plain text, with the heading line counted once: for item blocks
 *  `body[0]` is the heading itself. */
function blockText(b) {
  const body = b.type === 'item' ? b.body.slice(1) : b.body;
  return (b.head ? b.head + '\n' + body.join('\n') : body.join('\n')).trim();
}

/** A block back into markdown; list items get a clean, consecutive number. */
/**
 * A closing essay that the model appends after the last item of a numbered section
 * is not an item: it carries no timestamp and reads badly under the last heading.
 * It is kept verbatim, only moved after the list.
 */
function splitTail(block) {
  if (block.type !== 'item') return [];
  const paras = block.body.map((l) => String(l).trim()).filter(Boolean);
  if (paras.length < 4) return [];
  const keep = paras.slice(0, 3);
  const tail = [];
  for (const p of paras.slice(3)) {
    if (/\d{1,2}:\d{2}/.test(p)) {
      keep.push(p);
      continue;
    }
    tail.push(p);
  }
  if (tail.length) block.body = keep;
  return tail;
}

/**
 * A list entry the model wrote without any time still needs one: the heading is the
 * only thing a reader can click. The order of a list follows the stream, so the honest
 * estimate is the middle of the stretch between the entries around it that do have a
 * time. A run of untimed entries is spread evenly over that stretch, and a section with
 * no times at all is spread over the part of the video the report covers.
 */
function estimateTimes(blocks, duration) {
  const items = blocks.filter((b) => b.type === 'item');
  const timeOf = (b) => firstTime(b.head || '');
  const known = items.map(timeOf).filter((t) => t >= 0);
  const hi = known.length ? Math.max(...known) : Number(duration) || 0;
  if (!items.length) return;
  let left = 0;
  let run = [];
  const flush = (right) => {
    const gap = right - left;
    if (gap > 0) run.forEach((b, k) => { b.est = Math.round(left + (gap * (k + 1)) / (run.length + 1)); });
    run = [];
  };
  for (const b of items) {
    const t = timeOf(b);
    if (t >= 0) {
      flush(t);
      left = t;
    } else {
      run.push(b);
    }
  }
  flush(hi > left ? hi : left + 60);
}

/** The time a block is about: its own stamp, or the one its position in the list implies. */
function blockTime(b) {
  const t = firstTime(b.head || '');
  return t >= 0 ? t : Number(b.est ?? -1);
}

function renderBlocks(blocks, key, duration = 0) {
  const out = [];
  const tails = [];
  let n = 0;
  let lastSec = -1;
  estimateTimes(blocks, duration);
  // chronological order, anything without a timestamp last
  const ordered = blocks.slice().sort((a, b) => {
    const ta = blockTime(a);
    const tb = blockTime(b);
    if (ta < 0 && tb < 0) return 0;
    if (ta < 0) return 1;
    if (tb < 0) return -1;
    return ta - tb;
  });
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    if (b.type === 'heading') {
      out.push(b.head);
      continue;
    }
    if (b.type === 'item') {
      const numbered = key === 'highlights' || key === 'sharp';
      if (numbered && i === ordered.length - 1) tails.push(...splitTail(b));
      let nextStart = -1;
      for (let j = i + 1; j < ordered.length; j++) {
        if (ordered[j].type !== 'item') continue;
        const s = blockTime(ordered[j]);
        if (s >= 0) {
          nextStart = s;
          break;
        }
      }
      const rendered = cleanItem(b, numbered ? n + 1 : null, blockTime(b) >= 0 ? blockTime(b) : lastSec, nextStart);
      if (rendered) {
        if (numbered) n++;
        const t = firstTime(rendered);
        if (t >= 0) lastSec = t;
        out.push(rendered);
        continue;
      }
      // an item heading with nothing under it: that moment is already covered by
      // the item it was merged into, so a dangling numbered line is just noise.
      // The original list number is dropped - the numbering above is authoritative.
      const body = plainLines(b.body.slice(1)).join('\n\n').trim();
      if (body) out.push(((b.head ? b.head + '\n\n' : '') + body).trim());
      continue;
    }
    // body[0] is the heading line itself for item blocks
    const bodyLines = (b.type === 'item' ? b.body.slice(1) : b.body)
      .map((l) => String(l).trim())
      .filter(Boolean);
    const text = (b.head ? b.head + '\n' : '') + bodyLines.join('\n\n');
    if (text.trim()) out.push(text.trim());
  }
  const body = out.filter((x) => x.trim()).join('\n\n');
  return [body, ...tails.filter((x) => x.trim())].filter(Boolean).join('\n\n');
}

/** Rebuild the report from its own text: one heading per section, no duplicates. */
/**
 * Reports written by older versions of this code have no section headings, keep the
 * chunk subheadings (`### ...`) in the body, and carry `**发生了什么：**` labels.
 * Those can be repaired from the stored text alone, no LLM needed. Once a report has
 * the three sections and no loose subheading it is never touched again.
 */
function tidyReason(text, duration = 0, firstSpeech = null) {
  const lines = String(text || '').split('\n');
  const sections = lines.filter((l) => /^##\s/.test(l)).length;
  const loose = lines.filter((l) => /^###\s/.test(l)).length;
  const labels = lines.filter((l) => stripLabel(l) !== l).length;
  // Note: top-level numbered items ("1. **[00:00:37] …**") are the normal item
  // format, so nested-looking lines are not a reason to rewrite a report.
  const untitled = lines.filter((l) => BARE_STAMP_RE.test(l.trim())).length;
  // a nested heading with no timestamp at all, or an old markdown table left in place
  const fragments = lines.filter((l) => {
    const t = l.trim();
    return /^\|/.test(t) || (!t.startsWith('*') && isLooseFragment(t));
  }).length;
  // the degenerate tic: filler sentences that "analyse" a moment by restating its own
  // words. Asking trimCliches itself whether it would change a section is the only way
  // to be sure the two agree, and a section it would not change is tidy by definition.
  const filler = Object.values(reportSections(text)).some((body) => trimCliches(body, true) !== body);
  const reasons = [];
  if (sections < 3) reasons.push(`sections=${sections}`);
  if (loose) reasons.push(`looseHeadings=${loose}`);
  if (labels) reasons.push(`labels=${labels}`);
  if (untitled) reasons.push(`untitledStamps=${untitled}`);
  if (fragments) reasons.push(`fragments=${fragments}`);
  if (filler) reasons.push('filler');
  // anything the canonical form would still change: duplicate moments, list entries that
  // belong together, headings with nothing under them. The canonical form is the
  // assembler's output with the opening span anchored to the first utterance, so the
  // comparison uses the same pipeline generation does; otherwise the assembler trimming a
  // span and the anchor restoring it would look like an unstable report forever.
  if (anchorOpening(assembleReport(text, duration), firstSpeech) !== text) reasons.push('unstable');
  return reasons.join(' ');
}

function needsTidy(text, duration = 0, firstSpeech = null) {
  return Boolean(tidyReason(text, duration, firstSpeech));
}

/** A section heading written at the end of a paragraph line gets its own line. When the
 *  same heading also appears later as a line of its own, the glued one is a stray from a
 *  truncated answer and is dropped, otherwise the items that follow it would be filed
 *  under the wrong section. */
function splitHeadings(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#/.test(l) || !l.trim()) { out.push(l); continue; }
    const m = l.match(/#{1,4}\s*(?:一|二|三|四|五|六)[、.．]/);
    if (!m) { out.push(l); continue; }
    const key = sectionKey(l.slice(m.index));
    const before = l.slice(0, m.index).trim();
    if (before) out.push(before);
    if (key && lines.slice(i + 1).some((n) => sectionKey(n) === key)) continue;
    out.push(l.slice(m.index));
  }
  return out.join('\n');
}

function assembleReport(text, duration = 0) {
  text = fitTimestamps(splitHeadings(String(text || '')), duration);
  const groups = { intro: [], summary: [], highlights: [], sharp: [] };
  let current = 'intro';
  for (const b of splitBlocks(text)) {
    if (b.type === 'section') {
      current = b.key;
      groups[current].push(b);
      continue;
    }
    const key = classifyBlock(b, current);
    if (key !== current) b.key = key;
    groups[key].push(b);
    if (b.type === 'item' && key !== 'intro') current = key;
  }
  mergeDuplicates(groups);
  // entries the model left without a time are placed by where they sit in the list, so
  // the condenser can tell a bare heading belongs to the moment next to it
  for (const key of ['highlights', 'sharp']) estimateTimes(groups[key], duration);
  groups.highlights = condenseItems(groups.highlights, MAX_HIGHLIGHTS);
  groups.sharp = condenseItems(groups.sharp, MAX_SHARP_ITEMS);

  const parts = [];
  // an overview written before the first heading is the introduction of the
  // chronological summary, not a preamble: it goes under 一、 so the report always
  // starts with the first section
  const intro = groups.intro.length
    ? collapseRepeats(cleanSection(groups.intro.map((b) => blockText(b)).join('\n\n')))
    : '';
  for (const key of SECTION_ORDER) {
    const blocks = key === 'summary' ? mergeSummaryBlocks(groups[key]) : groups[key];
    let body = renderBlocks(blocks, key, duration);
    if (key === 'summary' && intro) body = [intro, body].filter(Boolean).join('\n\n');
    if (!body) continue;
    parts.push(SECTION_TITLES[key] + '\n' + collapseRepeats(cleanSection(trimCliches(body))));
  }
  if (!parts.length) return String(text).trim();
  // ranges are built from the headings, so a stamp that only appears after the
  // rendering step has to be checked again before the report leaves the assembler
  return fitTimestamps(parts.join('\n\n').trim(), duration);
}

/** Latest timestamp mentioned in a text, or -1 when there is none. */
function lastTime(text) {
  let max = -1;
  for (const m of String(text).matchAll(/(\d{1,2}):(\d{2}):(\d{2})/g)) max = Math.max(max, toSeconds(m));
  return max;
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Does any timestamp in the text, short or full, claim a moment past the end? */
function overruns(text, d) {
  for (const m of String(text).matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g)) {
    const h = Number(m[1]), mi = Number(m[2]);
    const v = m[3] ? h * 3600 + mi * 60 + Number(m[3]) : h * 3600 + mi * 60;
    if (v > d) return true;
  }
  return false;
}

/**
 * Timestamps outside the video are the model using a scale the stream does not have.
 * Two shapes show up: `06:27:00` for 6 minutes 27 seconds (a minute count written in
 * the hour field), and `00:30–03:00` for 0:30–3:00 (a two-field time written without
 * seconds). Each one is read in whichever sense puts it inside the stream; anything
 * still past the end is clamped to it. Only runs when the text really overruns the
 * video, so a correct report is never touched.
 */
function fitTimestamps(text, duration) {
  const d = Number(duration) || 0;
  if (!(d > 0)) return text;
  if (!overruns(text, d)) return text;
  let fixed = 0;

  // `01:23` is 1 hour 23 minutes unless the stream is shorter than that, in which
  // case it is 1 minute 23 seconds. Rewriting it in full form keeps every later
  // parser from guessing.
  let out = String(text).replace(/(?<![\d:])(\d{1,2}):(\d{2})(?!:\d{2})/g, (m, h, mi) => {
    const asHours = (+h) * 3600 + (+mi) * 60;
    if (asHours <= d) return m;
    const sec = Math.min((+h) * 60 + (+mi), d);
    fixed++;
    return formatTime(sec);
  });

  out = out.replace(/(\d{1,2}):(\d{2}):(\d{2})/g, (m, h, mi, s) => {
    const asWritten = (+h) * 3600 + (+mi) * 60 + (+s);
    if (asWritten <= d) return m;
    // `06:27:00` is 6 minutes 27 seconds: hour field is minutes, minute field seconds
    const asMinutes = (+h) * 60 + (+mi);
    const sec = asMinutes <= d ? asMinutes : d;
    fixed++;
    return formatTime(sec);
  });

  if (fixed) console.log(`[report] re-read ${fixed} timestamps outside the stream`);
  return out;
}

/** A section heading written as `HH:MM:SS–HH:MM:SS：title`. */
const HEAD_SPAN_RE = /(\d{1,2}):(\d{2}):(\d{2})\s*(?:[-–—~]|至|到)\s*(\d{1,2}):(\d{2}):(\d{2})/;

/** The first line of real speech in a timeline. Silence markers are not speech. */
function firstSpeechOfTimeline(timeline) {
  for (const line of String(timeline || '').split('\n')) {
    const m = line.match(/^\s*\[(\d{1,2}):(\d{2}):(\d{2})\]/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

/**
 * Reports written before the timeline skipped silence anchors open with a section whose
 * span sits in the stretch where nobody speaks. The transcript decides what that stretch
 * really is: nothing is written, nothing is removed, and running it twice changes nothing.
 *
 * - the span ends before the first utterance → it describes the silent pre-roll, so it
 *   becomes the real silent stretch (00:00 → first utterance);
 * - the span covers the first utterance → it starts where the speech starts.
 *
 * Applied after the assembler, which derives spans from the items it files, so the
 * correction is the last thing done to the text and cannot be undone by a later pass.
 */
function anchorOpening(text, firstSpeech) {
  const speech = Math.round(Number(firstSpeech) || 0);
  if (!(speech > 60)) return String(text || '');
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEAD_SPAN_RE);
    if (!m) continue;
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const end = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    if (start >= speech) return lines.join('\n');
    const from = end <= speech ? 0 : speech;
    const to = end <= speech ? speech : end;
    lines[i] = lines[i].replace(m[0], `${formatTime(from)}–${formatTime(to)}`);
    return lines.join('\n');
  }
  return lines.join('\n');
}

/** The part of the transcript after a timestamp, capped to what one call can hold. */
function timelineTail(timeline, fromSec) {
  const tail = String(timeline)
    .split('\n')
    .filter((l) => {
      const m = l.match(TIME_RE);
      return m && toSeconds(m) >= fromSec;
    });
  if (!tail.length) return '';
  return chunkByTokens(tail.join('\n'), CHUNK_TOKENS).slice(0, 2).join('\n');
}

/**
 * Fill in whatever the first draft did not write: a summary that stops before the
 * end of the stream, a missing highlight list, a missing commentary.
 */
async function completeReport(title, timeline, text, signal, ctx, duration = 0) {
  if (signal?.aborted) throw new Error('cancelled');
  const sections = reportSections(text);
  const maxOut = Math.min(3000, outputTarget(estimateTokens(timeline), ctx));

  // the source for the sections that were not written at all
  const source = estimateTokens(timeline) > CHUNK_TOKENS
    ? chunkByTokens(timeline, CHUNK_TOKENS).slice(0, 2).join('\n')
    : timeline;

  // a summary that stops halfway: ask for the rest of the stream only. A summary
  // with no timestamps at all is not chronological - the model wrote an overview of
  // the first part and stopped - so treat the second half as missing.
  const streamEnd = lastTime(timeline);
  const covered = lastTime(sections.summary);
  const from = covered >= 0 ? covered : Math.floor(streamEnd / 2);
  if (streamEnd > 0 && streamEnd - from > 420) {
    const tail = timelineTail(timeline, from);
    if (tail) {
      try {
        console.log(`[report] summary covers only up to ${formatTime(from)} of ${formatTime(streamEnd)}, writing the rest`);
        const more = cleanSection(
          await chatComplete(
            [
              { role: 'system', content: SYSTEM },
              {
                role: 'user',
                content: `直播「${title}」的内容总结只写到 ${formatTime(from)}，后面的时间没有提到。请只基于下面的转录（从 ${formatTime(from)} 到结尾，每行带 [HH:MM:SS] 时间戳）按时间顺序补充这一段里实际发生的环节和事件，每条带时间戳，写法与前面不同，不要重复已经写过的内容，不要标题、不要引言、不要客套话，结尾不能截断。\n\n${tail}`,
              },
            ],
            { maxTokens: maxOut, signal }
          )
        );
        if (more) sections.summary = (sections.summary + '\n\n' + more).trim();
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`[report] could not extend the summary: ${e.message}`);
      }
    }
  }

  if (!sections.summary) {
    try {
      sections.summary = cleanSection(
        await chatComplete(
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: `请基于直播「${title}」的转录（每行带 [HH:MM:SS] 时间戳）写「直播内容详细总结」：按时间顺序梳理从开场到结尾实际发生的环节和事件，写明每个环节大致发生了什么，必须覆盖全部时间。只写这一部分，不要标题、不要引言、不要客套话，结尾不能截断。\n\n${source}`,
            },
          ],
          { maxTokens: maxOut, signal }
        )
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[report] summary section missing and could not be generated: ${e.message}`);
    }
  }

  if (!sections.highlights) {
    try {
      sections.highlights = cleanSection(
        await chatComplete(
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: `请基于直播「${title}」的转录列出「精彩亮点 / 名场面」：按时间顺序，每条先给出开始时间 HH:MM:SS（取自时间戳），然后用两句话说明（先说明发生了什么，再说明为什么值得回看）。至少 ${MIN_HIGHLIGHTS} 条，最多 12 条，覆盖从开场到结尾。只输出列表，每条以时间戳开头，不要标题、不要引言、不要客套话，结尾不能截断。\n\n${source}`,
            },
          ],
          { maxTokens: maxOut, signal }
        )
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[report] highlights section missing and could not be generated: ${e.message}`);
    }
  } else if (countItems(sections.highlights) < MIN_HIGHLIGHTS) {
    // the list exists but is thin: two highlights next to twenty-four commentary
    // entries reads as a lost section, so ask for the moments it skipped
    const have = countItems(sections.highlights);
    const already = [...timeSet(sections.highlights)].map(formatTime).join('、');
    try {
      console.log(`[report] highlights section has ${have} items, filling it up`);
      const more = cleanSection(
        await chatComplete(
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: `直播「${title}」的「精彩亮点 / 名场面」清单只有 ${have} 条，太少。请只基于下面的转录（每行带 [HH:MM:SS] 时间戳）再补充至少 ${MIN_HIGHLIGHTS - have} 条值得回看的名场面：按时间顺序，每条先给出开始时间 HH:MM:SS（取自时间戳），然后用两句话说明（先说明发生了什么，再说明为什么值得回看）。${already ? `这些时间已经写过，不要再重复：${already}。` : ''}只输出列表，每条以时间戳开头，不要标题、不要引言、不要客套话，结尾不能截断。\n\n${source}`,
            },
          ],
          { maxTokens: maxOut, signal }
        )
      );
      if (more) sections.highlights = mergeDrafts(sections.highlights, more, []).trim();
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[report] could not fill the highlights section: ${e.message}`);
    }
  }

  if (!sections.sharp) {
    try {
      sections.sharp = cleanSection(
        await chatComplete(
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: `请基于直播「${title}」的转录写一份「辛辣锐评」：${SHARP_COMMENT_RULES}\n只基于转录中真实发生的场面，每条以时间戳 HH:MM:SS 开头，先复述场面并引用原话，再一句补刀，相邻两条不能用相同的句式或相同的结尾，不要标题、不要引言，结尾不能截断。\n\n${source}`,
            },
          ],
          { maxTokens: maxOut, signal }
        )
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[report] sharp section missing and could not be generated: ${e.message}`);
    }
  }

  // a sharp section that only restates what happened is not a 锐评: ask once more
  // with the punchline requirement spelled out, keep the punchier version, and merge
  // in any moment only the flat draft mentioned so nothing is lost
  if (sections.sharp && punchRatio(sections.sharp) < PUNCH_MIN_RATIO) {
    for (let attempt = 1; attempt <= 2 && punchRatio(sections.sharp) < PUNCH_MIN_RATIO; attempt++) {
      const before = punchRatio(sections.sharp);
      try {
        console.log(`[report] sharp section reads flat (${Math.round(before * 100)}% punchlines), writing it again (attempt ${attempt})`);
        const retry = cleanSection(
          await chatComplete(
            [
              { role: 'system', content: SYSTEM },
              {
                role: 'user',
                content: `请基于直播「${title}」的转录写一份「辛辣锐评」：${SHARP_COMMENT_RULES}\n只基于转录中真实发生的场面，每条以时间戳 HH:MM:SS 开头，先复述场面并引用原话，再一句补刀，相邻两条不能用相同的句式或相同的结尾。\n每条的最后一句必须是补刀：反问、夸张、类比、弹幕反应或自嘲都可以；只复述场面、没有吐槽的条目不合格。\n一个场面如果本身没有笑点，可以不写它，只写真正有笑点的场面。不要标题、不要引言，结尾不能截断。\n\n${source}`,
              },
            ],
            { maxTokens: maxOut, signal }
          )
        );
        const after = punchRatio(retry);
        if (retry && after > before) {
          console.log(`[report] sharp section rewritten for punchlines (${Math.round(before * 100)}% -> ${Math.round(after * 100)}%)`);
          sections.sharp = mergeDrafts(retry, sections.sharp, []).trim();
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`[report] sharp section punchline retry skipped: ${e.message}`);
        break;
      }
    }
  }

  const parts = [];
  if (sections.intro) parts.push(cleanSection(sections.intro));
  if (sections.summary) parts.push('## 一、直播内容详细总结\n' + normalizeHeadings(sections.summary));
  if (sections.highlights) parts.push('## 二、精彩亮点 / 名场面\n' + cleanSection(sections.highlights));
  if (sections.sharp) parts.push('## 三、辛辣锐评\n' + cleanSection(trimCliches(sections.sharp)));
  if (!parts.length) throw new Error('report generation produced no content');
  dumpRaw('pre-assemble', parts.join('\n\n'));
  // the assembler builds spans from the items it files, so anchoring the opening
  // section is done after it, otherwise the assembler would undo it
  return anchorOpening(assembleReport(parts.join('\n\n'), duration), firstSpeechOfTimeline(timeline));
}

/**
 * Generate the report.
 * - short transcripts: one call, with an output budget scaled to the transcript
 *   length and automatic continuation when the model hits the cap
 * - long transcripts: notes per time block, then code assembles the three sections
 *   so the report covers the whole stream instead of the first hour
 */
/**
 * LIKLO_RAW=<path> writes every model draft before the assembler touches it. Reports
 * are stored only after assembly, so this is the only way to see how a formatting
 * artifact got in.
 */
function dumpRaw(stage, text) {
  if (!process.env.LIKLO_RAW) return;
  try {
    require('fs').appendFileSync(process.env.LIKLO_RAW, `\n===== ${stage} =====\n${String(text)}\n`);
  } catch {}
}

async function generateReport(title, timeline, opts = {}) {
  const ctx = await llmContext();
  const inputTokens = estimateTokens(timeline);
  // the real length of the stream: timestamps the model invents outside it are
  // minute counts written in the hour field, and the assembler needs the duration to
  // recognise that
  const duration = Number(opts.duration) || 0;

  if (inputTokens <= SECTION_THRESHOLD) {
    const target = outputTarget(inputTokens, ctx);
    // ask for roughly what the budget can actually hold, otherwise the model
    // pads until it degenerates into a repetition loop
    const lengthTarget = Math.min(Math.round(target * 1.2), 6000);
    console.log(`[report] single-shot: ${inputTokens} input tokens, target ${target} output tokens (window ${ctx})`);
    try {
      const draft = await diversify((banned) => reportPrompt(title, timeline, lengthTarget, banned), target, opts.signal);
      dumpRaw('draft', draft);
      // the draft is only as complete as one answer can be: fill in anything the
      // model did not get to write before the answer ended
      return await completeReport(title, timeline, draft, opts.signal, ctx, duration);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      console.warn(`[report] single-shot report failed (${e.message}), falling back to section mode`);
    }
  }

  const chunks = chunkByTokens(timeline, CHUNK_TOKENS);
  const notes = [];
  // clichés detected in earlier blocks are forbidden for later ones: blocks are
  // generated serially, so this stops the per-block notes from drifting into one style
  const banned = [];
  const driftCounts = new Map();

  // the local model sometimes answers a long prompt with an empty completion; one
  // failed block should not throw away the whole report, so a failing block is
  // retried as two smaller prompts and only skipped if that fails too
  async function noteChunk(chunk, idx, total) {
    try {
      return [await noteBlock(title, chunk, idx, total, opts.signal, banned)];
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      console.warn(`[report] block ${idx} failed (${e.message}), retrying as two smaller prompts`);
      const out = [];
      for (const half of splitChunk(chunk)) {
        try {
          out.push(await noteBlock(title, half, idx, total, opts.signal, banned));
        } catch (e2) {
          if (opts.signal?.aborted) throw e2;
          console.warn(`[report] half of block ${idx} skipped: ${e2.message}`);
        }
      }
      return out;
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    console.log(`[report] noting block ${i + 1}/${chunks.length} (${estimateTokens(chunks[i])} tokens)`);
    const parts = await noteChunk(chunks[i], i + 1, chunks.length);
    notes.push(...parts);
    for (const part of parts) {
      for (const p of collectDrift(blockSummary(part.raw), '', driftCounts, 8)) {
        if (!banned.includes(p)) banned.push(p);
      }
    }
    await sleep(800);
  }

  const highlights = dedupeItems(notes.flatMap((n) => extractItems(n.raw, '名场面')));
  const memes = dedupeItems(notes.flatMap((n) => extractItems(n.raw, '有梗场面')));
  const sharpItems = spreadItems(memes, MAX_SHARP_ITEMS);

  const sections = notes.map((n) => blockSummary(n.raw)).filter(Boolean);
  const drift = badTemplates(sections.join('\n'));
  if (drift.length) console.warn(`[report] section 1 phrasing drift: ${drift.map(([p, n]) => `${p} ×${n}`).join(', ')}`);
  const overviewInput = sections.map((s) => s.slice(0, 900)).join('\n\n');
  const maxOut = outputTarget(estimateTokens(overviewInput) + inputTokens / 4, ctx);

  let overview = '';
  try {
    overview = await diversify(
      (extra) =>
        `下面是直播「${title}」各时间段的要点（带时间戳）。请写一段 300-500 字的开场概览：这场直播大概是什么内容、主要环节、整体氛围。只写概览，不要重复逐条要点，不要客套话，结尾不能截断。${[...banned, ...extra].length ? `\n必须完全不用这些句式：${[...banned, ...extra].map((b) => `「${b}」`).join('、')}。` : ''}\n\n${overviewInput}`,
      Math.min(2000, maxOut),
      opts.signal
    );
  } catch (e) {
    console.warn(`[report] overview failed: ${e.message}`);
  }

  let highlightText = '';
  if (highlights.length) {
    // the condensation call sometimes answers with two items although thirty were
    // collected; ask again with the candidates it did not use until the list has a
    // real length, instead of leaving section 二 thinner than section 三
    const highlightPrompt = (pool, extra, already) =>
      `下面是直播「${title}」各时间段收集到的「名场面」候选（带时间戳）。请整理成一份值得回看的片段清单：按时间顺序，每条先给出开始时间 HH:MM:SS，然后用两句话说明（先说明发生了什么，再说明为什么值得回看）；合并重复项；至少 ${MIN_HIGHLIGHTS} 条，最多 12 条。每条的写法要不同，不要套用同一个句式。只输出列表，每条以 HH:MM:SS 开头，不要标题、不要引言、不要客套话，结尾不能截断。${already ? `\n这些时间已经写过了，只补充新的：${already}。` : ''}${[...banned, ...extra].length ? `\n必须完全不用这些句式：${[...banned, ...extra].map((b) => `「${b}」`).join('、')}。` : ''}\n\n${itemsToText(pool)}`;

    for (let attempt = 0; attempt < 3 && countItems(highlightText) < MIN_HIGHLIGHTS; attempt++) {
      if (opts.signal?.aborted) throw new Error('cancelled');
      const written = timeSet(highlightText);
      const pool = attempt === 0 ? highlights : highlights.filter((h) => !written.has(timeToSeconds(h.time)));
      if (!pool.length) break;
      if (attempt) {
        console.log(
          `[report] highlights section has ${countItems(highlightText)} items, writing more from ${pool.length} unused candidates (attempt ${attempt + 1}/3)`
        );
      }
      try {
        const draft = await diversify(
          (extra) => highlightPrompt(pool, extra, [...written].map(formatTime).join('、')),
          Math.min(3000, maxOut),
          opts.signal
        );
        if (draft) highlightText = mergeDrafts(highlightText, draft, banned);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        console.warn(`[report] highlights attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
  }
  if (!highlightText) highlightText = itemsToText(highlights) || sections.join('\n\n').slice(0, 4000);

  // one short paragraph per collected moment: that is what the model can actually
  // write without repeating itself, so the length target follows the item count.
  // the moments are commented on in small batches, each batch with the clichés used
  // by the previous batches forbidden, because a single 24-item answer degenerates
  // into one template line per item.
  let sharpText = '';
  if (memes.length) {
    const batches = [];
    for (let i = 0; i < sharpItems.length; i += SHARP_BATCH) batches.push(sharpItems.slice(i, i + SHARP_BATCH));
    const drafts = [];
    const sharpBanned = [...banned];
    const sharpCounts = new Map();

    const sharpPrompt = (items, group, extra, lengthTarget, strict = false) =>
      `下面是直播「${title}」第 ${group}/${batches.length} 组「有梗 / 有趣 / 太变态 / 太感动」的场面（带时间戳）。请逐条写成辛辣锐评：${SHARP_COMMENT_RULES}\n只基于下面列出的场面，不要编造，不要客套话，不要标题或引言，每个场面一段（最多两句，每条不超过 120 字），每条以时间戳 HH:MM:SS 开头，直接写场面和笑点，不要抽象总结（例如「这种修辞本身构成一种荒诞的仪式」这类句子），篇幅约 ${lengthTarget} 字，结尾不能截断。\n每条的写法都要不同：先复述场面并引用原话，再一句补刀；相邻两条不能用相同的句式或相同的结尾。${strict ? '\n每条的最后一句必须是补刀：反问、夸张、类比、弹幕反应或自嘲都可以；只复述场面、没有吐槽的条目不合格。\n一个场面如果本身没有笑点，可以不写它，只写真正有笑点的场面。' : ''}${[...sharpBanned, ...extra].length ? `\n这些句子已经被反复套用，这次必须完全不用：${[...sharpBanned, ...extra].map((b) => `「${b}」`).join('、')}。` : ''}\n\n${itemsToText(items)}`;

    for (let i = 0; i < batches.length; i++) {
      if (opts.signal?.aborted) throw new Error('cancelled');
      const items = batches[i];
      const lengthTarget = 400 + items.length * 100;
      console.log(`[report] sharp batch ${i + 1}/${batches.length} (${items.length} moments)`);
      let raw = '';
      try {
        raw = await diversify((extra) => sharpPrompt(items, i + 1, extra, lengthTarget), Math.min(1600, maxOut), opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        // the batch was too much for one answer: split it into smaller groups so
        // every moment still gets a comment instead of dropping the tail of the batch
        console.warn(`[report] sharp batch ${i + 1} failed (${e.message}), retrying in groups of 4`);
        const parts = [];
        for (let j = 0; j < items.length; j += 4) {
          if (opts.signal?.aborted) throw new Error('cancelled');
          const sub = items.slice(j, j + 4);
          try {
            parts.push(cleanSection(await diversify((extra) => sharpPrompt(sub, i + 1, extra, 400 + sub.length * 100), Math.min(1200, maxOut), opts.signal)));
          } catch (e2) {
            if (opts.signal?.aborted) throw e2;
            console.warn(`[report] sharp sub-group ${j / 4 + 1} of batch ${i + 1} skipped: ${e2.message}`);
          }
        }
        raw = parts.join('\n\n');
      }
      if (!raw) continue;
      // a batch that only restates what happened is not a 锐评: ask once more with
      // the punchline requirement spelled out, and keep whichever version has more
      // actual punchlines so nothing is thrown away
      if (punchRatio(raw) < PUNCH_MIN_RATIO) {
        for (let attempt = 1; attempt <= 2 && punchRatio(raw) < PUNCH_MIN_RATIO; attempt++) {
          try {
            const retry = cleanSection(
              await diversify((extra) => sharpPrompt(items, i + 1, extra, lengthTarget, true), Math.min(1600, maxOut), opts.signal)
            );
            const before = punchRatio(raw);
            const after = punchRatio(retry);
            if (retry && after > before) {
              console.log(`[report] sharp batch ${i + 1} rewritten for punchlines (${Math.round(before * 100)}% -> ${Math.round(after * 100)}%)`);
              // keep the punchy wording, but merge back any moment the flat draft
              // mentioned and the strict one skipped
              raw = mergeDrafts(retry, raw, []);
            }
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            console.warn(`[report] sharp batch ${i + 1} punchline retry skipped: ${e.message}`);
            break;
          }
        }
      }
      drafts.push(cleanSection(raw));
      for (const p of collectDrift(raw, '', sharpCounts, 12)) {
        if (!sharpBanned.includes(p)) sharpBanned.push(p);
      }
      await sleep(500);
    }
    sharpText = drafts.filter(Boolean).join('\n\n');
    const driftSharp = badTemplates(sharpText);
    if (driftSharp.length) console.warn(`[report] sharp section drift: ${driftSharp.map(([p, n]) => `${p} ×${n}`).join(', ')}`);
  } else {
    try {
      sharpText = await diversify(
        (extra) =>
          `下面是直播「${title}」各时间段的要点总结。请从中挑出「有梗 / 有趣 / 太变态 / 太感动」的场面写成一份辛辣锐评：${SHARP_COMMENT_RULES}\n句式要变化，不要重复同一句式，每条以时间戳 HH:MM:SS 开头，篇幅约 ${Math.min(3000, Math.round(maxOut * 1.2))} 字，结尾不能截断。${[...banned, ...extra].length ? `\n必须完全不用这些句式：${[...banned, ...extra].map((b) => `「${b}」`).join('、')}。` : ''}\n\n${overviewInput}`,
        Math.min(3000, maxOut),
        opts.signal
      );
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      console.warn(`[report] sharp section failed: ${e.message}`);
    }
  }

  const parts = [];
  if (overview) parts.push(cleanSection(overview));
  if (sections.length) parts.push('## 一、直播内容详细总结\n' + sections.map(normalizeHeadings).join('\n\n'));
  if (highlightText) parts.push('## 二、精彩亮点 / 名场面\n' + cleanSection(highlightText));
  if (sharpText) parts.push('## 三、辛辣锐评\n' + cleanSection(sharpText));
  if (!parts.length) throw new Error('report generation produced no content');
  dumpRaw('pre-assemble', parts.join('\n\n'));
  // the assembler builds spans from the items it files, so anchoring the opening
  // section is done after it, otherwise the assembler would undo it
  return anchorOpening(assembleReport(parts.join('\n\n'), duration), firstSpeechOfTimeline(timeline));
}

module.exports = {
  generateReport,
  assembleReport,
  needsTidy,
  tidyReason,
  fillerSentences,
  splitBlocks,
  classifyBlock,
  condenseItems,
  renderBlocks,
  cleanItem,
  mergeDuplicates,
  splitHeadings,
  fitTimestamps,
  anchorOpening,
  firstSpeechOfTimeline,
  chat,
  chatComplete,
  estimateTokens,
  chunkByTokens,
  llmContext,
  outputTarget,
  SYSTEM,
  noteBlock,
  chunkRange,
  extractItems,
  spreadItems,
  itemsToText,
  cleanSection,
  cleanStutter,
  cleanDegenerate,
  trimIncompleteEnd,
  reportSections,
  completeReport,
  lastTime,
  dedupeItems,
  diversify,
  templateCounts,
  topTemplates,
  repeatedPhrases,
  badTemplates,
  worstReuse,
  countItems,
  trimCliches,
  punchRatio,
  itemBodies,
  BARE_STAMP_RE,
  itemParts,
  anyRange,
  rangeOf,
  bestTitle,
  isTitleLine,
  cleanTitle,
  SUB_STAMP_RE,
  isHeadingLine,
  mergeDuplicates,
  estimateTimes,
  fitTimestamps,
  windowOf,
};
