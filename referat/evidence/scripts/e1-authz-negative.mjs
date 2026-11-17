// E1 (5A): Unberechtigter Zugriff auf Kontextvorschau / Summary-Schnittstellen.
// Baseline v1.3.0, Laborinstanz 127.0.0.1. Erwartung: nur der gültige Host der
// eigenen Session erhält Daten; alle anderen Identitäten → UNAUTHORIZED, 0 Kontextbytes.
//
// Aufruf: ADMIN_SECRET aus lab/.env.production wird per Env übergeben (nie geloggt):
//   ADMIN_SECRET=... node referat/evidence/scripts/e1-authz-negative.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  createQaSession,
  joinAs,
  nick,
  submitQuestion,
  query,
  mutate,
  unwrap,
  hostHeaders,
  participantHeaders,
} from './lib/trpc.mjs';

// E1_REF trennt die Datensätze je Codestand (v1.3.0 / main-…).
const OUT = new URL(
  `../data/e1-authz-negative-${process.env.E1_REF ?? 'v1.3.0'}.json`,
  import.meta.url,
);

const A = await createQaSession({ title: 'E1 Session A' });
const B = await createQaSession({ title: 'E1 Session B' });
const alice = await joinAs(A.code, nick(0));
await submitQuestion(A, alice, 'Wird die Anwesenheit in der Übung kontrolliert?');
await submitQuestion(A, alice, 'Kommt Regression in der Klausur dran?');

const procedures = [
  ['query', 'qa.summaryRuntime', { sessionId: A.sessionId }],
  ['query', 'qa.summaryContextPreview', { sessionId: A.sessionId, locale: 'de' }],
  ['mutation', 'qa.requestSummary', { sessionId: A.sessionId, locale: 'de' }],
];

const identities = {
  'C0 Host A (gültig, Positivkontrolle)': hostHeaders(A.hostToken),
  'C1 ohne Token': {},
  'C2 Teilnehmer-Capability von A': participantHeaders(alice),
  'C3 Teilnehmer-Capability als x-host-token': hostHeaders(alice.capability),
  'C4 Host-Token von Session B': hostHeaders(B.hostToken),
  'C5 zufälliges 256-bit-Token': hostHeaders(randomBytes(32).toString('base64url')),
  'C6 Browser-Capability von A als x-host-token': hostHeaders(A.hostBrowserCapability),
};

async function runMatrix(label, ids) {
  const rows = [];
  for (const [idName, headers] of Object.entries(ids)) {
    for (const [kind, proc, input] of procedures) {
      const fn = kind === 'query' ? query : mutate;
      const r = await fn(proc, input, headers);
      rows.push({
        phase: label,
        identity: idName,
        procedure: proc,
        httpStatus: r.httpStatus,
        trpcCode: r.trpcCode,
        leakedContext: r.data !== null,
        responseBytes: r.responseBytes,
        ms: r.ms,
      });
    }
  }
  return rows;
}

const rows = await runMatrix('vor Widerruf', identities);

// C7: Widerruf über den auditierten Admin-Reset-Pfad (admin.resetSessionHostAccess).
let revocation = { performed: false };
if (process.env.ADMIN_SECRET) {
  const login = unwrap(await mutate('admin.login', { secret: process.env.ADMIN_SECRET }));
  const reset = await mutate(
    'admin.resetSessionHostAccess',
    {
      code: A.code,
      operationId: randomUUID(),
      evidenceCategory: 'PREEXISTING_VERIFIED_SUPPORT_CASE',
      requesterIdentityVerificationReference: 'LAB-E1',
      sessionAuthorizationEvidenceReference: 'LAB-E1',
      supportCaseReference: 'LAB-E1',
      reason: 'Laborversuch E1: Widerruf des Host-Tokens',
    },
    { 'x-admin-token': login.token },
  );
  revocation = { performed: reset.httpStatus === 200, httpStatus: reset.httpStatus };
  rows.push(
    ...(await runMatrix('nach Admin-Reset', {
      'C7 altes Host-Token A nach Widerruf': hostHeaders(A.hostToken),
    })),
  );
  // C8 prüft die Neuausstellung: alte Browser-Capability darf kein neues Token minten.
  const reissue = await mutate('session.issueHostAccessToken', {
    code: A.code,
    browserCapability: A.hostBrowserCapability,
  });
  rows.push({
    phase: 'nach Admin-Reset',
    identity: 'C8 alte Browser-Capability A nach Widerruf',
    procedure: 'session.issueHostAccessToken',
    httpStatus: reissue.httpStatus,
    trpcCode: reissue.trpcCode,
    leakedContext: reissue.data !== null,
    responseBytes: reissue.responseBytes,
    ms: reissue.ms,
  });
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    { experiment: 'E1', baseline: 'v1.3.0', at: new Date().toISOString(), revocation, rows },
    null,
    2,
  ),
);

const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) {
  console.log(
    pad(r.phase, 18),
    pad(r.identity, 46),
    pad(r.procedure, 30),
    pad(r.httpStatus, 4),
    pad(r.trpcCode ?? 'OK', 14),
    r.leakedContext ? 'DATEN' : '-',
  );
}
const negatives = rows.filter((r) => !r.identity.startsWith('C0'));
const leaks = negatives.filter((r) => r.leakedContext).length;
console.log(`\nNegativfälle: ${negatives.length}, davon mit Daten: ${leaks}`);
