'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'liklo.db'));
const rows = db.prepare('SELECT id,bvid,status,stage,updated_at,length(report) AS report_len,transcript_path,error FROM jobs ORDER BY id').all();
for (const r of rows) console.log(JSON.stringify(r));
