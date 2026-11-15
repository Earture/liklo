'use strict';
/**
 * Relabel jobs whose streamer field is the collection UP instead of the person who
 * actually streamed, e.g. a channel called 「牧场草原神official」 whose 合集 are
 * 「莉蔻Liko直播录像」. The label is taken from the video title with the same
 * detector the monitor uses (src/bilibili.js detectPersona), and only names that
 * already exist in the name table are accepted, so a stray word in a title never
 * becomes a streamer.
 *
 * Nothing else is touched: no download, no ASR, no report regeneration, and
 * updated_at is left alone so the "生成于" time and the generation-time sort stay
 * correct.
 *
 *   node scripts/relabel-personas.js            # dry run, prints the changes
 *   node scripts/relabel-personas.js --apply    # write them
 *   node scripts/relabel-personas.js --apply --bvid BV1Jtpj6BEVh
 */
const db = require('../src/db');
const names = require('../src/names');
const bilibili = require('../src/bilibili');

function main() {
  const apply = process.argv.includes('--apply');
  const only = process.argv.find((a) => /^BV/i.test(a));

  const known = new Map(
    db.listNames().map((n) => [String(n.name).toLowerCase(), n])
  );

  const rows = db.db
    .prepare(
      'SELECT id, bvid, title, streamer_name, english FROM jobs WHERE title IS NOT NULL AND title <> \'\' ORDER BY id'
    )
    .all();

  const changes = [];
  for (const row of rows) {
    if (only && row.bvid !== only) continue;
    const persona = bilibili.detectPersona(row.title, '');
    if (!persona || !persona.name) continue;
    const knownName = known.get(persona.name.toLowerCase());
    if (!knownName) continue; // not a person we know: leave the label as it is
    const nextName = knownName.name;
    const nextEnglish = persona.english || knownName.english || row.english || '';
    if (row.streamer_name === nextName && (row.english || '') === nextEnglish) continue;
    changes.push({
      id: row.id,
      bvid: row.bvid,
      from: row.streamer_name,
      to: nextName,
      english: nextEnglish,
      title: String(row.title).slice(0, 60),
    });
  }

  console.log(`scanned ${rows.length} jobs, ${changes.length} labels to change`);
  for (const c of changes) {
    console.log(`  #${c.id} ${c.bvid}  ${c.from} -> ${c.to} (${c.english})  | ${c.title}`);
  }
  if (!changes.length) return;

  if (!apply) {
    console.log('dry run: add --apply to write the changes');
    return;
  }

  const update = db.db.prepare('UPDATE jobs SET streamer_name = ?, english = ? WHERE id = ?');
  for (const c of changes) update.run(c.to, c.english, c.id);
  console.log(`updated ${changes.length} labels (reports, transcripts and timestamps untouched)`);

  const counts = {};
  for (const r of db.listReports({ limit: 1000 })) counts[r.streamer_name] = (counts[r.streamer_name] || 0) + 1;
  console.log('report labels now:', counts);
}

main();
