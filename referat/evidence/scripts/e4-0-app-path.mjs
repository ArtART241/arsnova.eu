// E4-0 (5B, Verfügbarkeit): realer App-Pfad qa.requestSummary → Queue → Qwen3 → Validierung
// mit der Produktionskonfiguration (QA_SUMMARY_TIMEOUT_MS=8000). Misst, ob eine benigne
// #456-Session überhaupt eine generative Zusammenfassung erhält, bevor E4 das Modell direkt prüft.
//
//   node referat/evidence/scripts/e4-0-app-path.mjs [--runs 3]
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import {
  createQaSession,
  nick,
  hostHeaders,
  joinAs,
  mutate,
  query,
  submitQuestion,
} from './lib/trpc.mjs';

const FIX = JSON.parse(
  readFileSync(new URL('../fixtures/e4-injection-fixtures.json', import.meta.url), 'utf8'),
);
const OUT = new URL('../data/e4-0-app-path.jsonl', import.meta.url);
const args = process.argv.slice(2);
const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3;
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let run = 0; run < runs; run += 1) {
  const session = await createQaSession({ title: `E4-0 App-Pfad ${run + 1}` });
  for (let i = 0; i < FIX.benign.length; i += 1) {
    const p = await joinAs(session.code, nick(i));
    await submitQuestion(session, p, FIX.benign[i]);
  }
  const headers = hostHeaders(session.hostToken);
  const started = Date.now();
  const req = await mutate(
    'qa.requestSummary',
    { sessionId: session.sessionId, locale: 'de' },
    headers,
  );
  let last = null;
  const polls = [];
  while (Date.now() - started < 120_000) {
    await sleep(500);
    last = await query('qa.summaryRuntime', { sessionId: session.sessionId }, headers);
    const r = last.data?.result ?? null;
    polls.push({ t: Date.now() - started, status: r?.status ?? null });
    if (r && r.status !== 'pending' && r.status !== 'running' && r.status !== 'queued') break;
  }
  const result = last?.data?.result ?? null;
  const row = {
    at: new Date().toISOString(),
    run,
    requestHttp: req.httpStatus,
    requestCode: req.trpcCode,
    request: req.data,
    elapsedMs: Date.now() - started,
    finalStatus: result?.status ?? null,
    reason: result?.execution?.fallback?.reason ?? null,
    origin: result?.execution?.effectiveMode ?? null,
    modelVersion: result?.modelVersion ?? null,
    statements: result?.statements?.length ?? null,
    statusTrace: [...new Set(polls.map((p) => p.status))],
    result,
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(
    `run ${run + 1}: request=${req.httpStatus}/${req.trpcCode ?? 'OK'} final=${row.finalStatus}`,
    `reason=${row.reason} origin=${row.origin} statements=${row.statements} after ${row.elapsedMs}ms`,
  );
}
