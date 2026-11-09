const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const profile = join(process.env.APPDATA, 'tinygpt-desktop');
const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
console.log(JSON.stringify({ route: settings.route, provider: settings.byok?.provider, model: settings.byok?.model, protocol: settings.byok?.protocol, contextWindowTokens: settings.byok?.contextWindowTokens, maxOutputTokens: settings.byok?.maxOutputTokens, tools: settings.byok?.tools }));
const db = new DatabaseSync(join(profile, 'library.sqlite'), { readOnly: true });
const rows = db.prepare(`SELECT m.status,m.error,m.route,LENGTH(m.text) AS textChars,LENGTH(m.reasoning) AS reasoningChars,m.work_duration_ms AS workMs,
 (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id=m.run_id) AS tools,
 (SELECT GROUP_CONCAT(status) FROM context_activities a WHERE a.run_id=m.run_id) AS optimization,
 (SELECT input_tokens FROM context_usage u WHERE u.run_id=m.run_id) AS inputTokens,
 (SELECT output_tokens FROM context_usage u WHERE u.run_id=m.run_id) AS outputTokens,
 (SELECT COUNT(*) FROM messages prior WHERE prior.conversation_id=m.conversation_id AND prior.seq<=m.seq) AS messages
 FROM messages m WHERE m.role='assistant' ORDER BY m.seq DESC LIMIT 8`).all();
console.log(JSON.stringify(rows));
const latest = db.prepare("SELECT run_id,conversation_id,created_at,work_duration_ms,response_duration_ms FROM messages WHERE role='assistant' ORDER BY seq DESC LIMIT 1").get();
if (latest) {
  console.log(JSON.stringify({ latestTiming: { workMs: latest.work_duration_ms, responseMs: latest.response_duration_ms,
    optimization: db.prepare('SELECT status,created_at-? AS beganMs FROM context_activities WHERE run_id=?').all(latest.created_at, latest.run_id),
    tools: db.prepare('SELECT name,status,created_at-? AS beganMs,LENGTH(result) AS resultChars FROM tool_calls WHERE run_id=? ORDER BY created_at').all(latest.created_at, latest.run_id),
    checkpoints: db.prepare('SELECT LENGTH(text) AS chars FROM context_checkpoints WHERE conversation_id=?').all(latest.conversation_id),
  } }));
}
db.close();
