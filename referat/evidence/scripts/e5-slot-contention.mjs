// E5 (5B, Missbrauch): Hält ein anonymer Nutzer über quiz.deriveLearningObjectives den einzigen
// LLM-Slot belegt, und was sehen Hosts anderer Sessions währenddessen?
// Phase "kontrolle": nur Host-Summaries. Phase "angriff": dieselben Host-Summaries, parallel eine
// anonyme Schleife prepare → derive (ohne Session, ohne Login). Ergebnis: data/e5-slot-contention.jsonl
//
//   node referat/evidence/scripts/e5-slot-contention.mjs [--victims 3] [--attack-seconds 240]
import { randomUUID } from 'node:crypto';
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
const OUT = new URL('../data/e5-slot-contention.jsonl', import.meta.url);
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt);
const VICTIMS = opt('--victims', 3);
const ATTACK_SECONDS = opt('--attack-seconds', 240);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (row) => {
  appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  console.log(JSON.stringify(row));
};

async function victimSummary(phase, index) {
  const session = await createQaSession({ title: `E5 Opfer ${phase} ${index}` });
  for (let i = 0; i < FIX.benign.length; i += 1) {
    await submitQuestion(session, await joinAs(session.code, nick(i)), FIX.benign[i]);
  }
  const headers = hostHeaders(session.hostToken);
  const started = Date.now();
  await mutate('qa.requestSummary', { sessionId: session.sessionId, locale: 'de' }, headers);
  let result = null;
  while (Date.now() - started < 200_000) {
    await sleep(1_000);
    const r = await query('qa.summaryRuntime', { sessionId: session.sessionId }, headers);
    result = r.data?.result ?? null;
    if (result && result.status !== 'pending') break;
  }
  log({
    kind: 'victim',
    phase,
    index,
    ms: Date.now() - started,
    status: result?.status ?? null,
    effectiveMode: result?.execution?.effectiveMode ?? null,
    fallbackReason: result?.execution?.fallback?.reason ?? null,
    statements: result?.statements?.length ?? null,
  });
}

/** Anonyme Lernziel-Ableitung: zehn Quizfragen, keine Session, kein Login. */
function derivationQuestions() {
  return Array.from({ length: 10 }, (_, i) => ({
    sourceQuestionId: randomUUID(),
    enabled: true,
    text: `Welche Aussage zur linearen Regression trifft in Fall ${i + 1} zu?`,
    type: 'SINGLE_CHOICE',
    difficulty: 'MEDIUM',
    order: i,
    answers: [
      { text: 'Die Residuen summieren sich zu null.', isCorrect: true },
      { text: 'Die Steigung ist immer positiv.', isCorrect: false },
    ],
  }));
}

async function attackerLoop(stopAt) {
  let n = 0;
  while (Date.now() < stopAt) {
    const correlation = {
      schemaVersion: 1,
      operationId: randomUUID(),
      quizId: randomUUID(),
      expectedBundleRevision: 0,
    };
    const prep = await mutate('quiz.prepareLearningObjectiveDerivation', correlation);
    if (!prep.data?.capability) {
      log({ kind: 'attacker', n, step: 'prepare', http: prep.httpStatus, code: prep.trpcCode });
      await sleep(1_000);
      continue;
    }
    const started = Date.now();
    const run = await mutate('quiz.deriveLearningObjectives', {
      ...correlation,
      capability: prep.data.capability,
      locale: 'de',
      maximumDrafts: 4,
      questions: derivationQuestions(),
    });
    log({
      kind: 'attacker',
      n,
      ms: Date.now() - started,
      http: run.httpStatus,
      code: run.trpcCode,
      status: run.data?.status ?? null,
    });
    n += 1;
  }
}

// Phase 1: Kontrolle (ohne Angreifer, nacheinander)
for (let i = 0; i < VICTIMS; i += 1) await victimSummary('kontrolle', i);

// Phase 2: Angriff (anonyme Schleife läuft, Opfer im Abstand von 20 s)
const stopAt = Date.now() + ATTACK_SECONDS * 1_000;
const attacker = attackerLoop(stopAt);
await sleep(3_000);
const victims = [];
for (let i = 0; i < VICTIMS; i += 1) {
  victims.push(victimSummary('angriff', i));
  await sleep(20_000);
}
await Promise.all([attacker, ...victims]);
