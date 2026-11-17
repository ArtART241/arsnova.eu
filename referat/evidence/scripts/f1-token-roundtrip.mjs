// F1 (5B) live: Speichert der Server einen von Teilnehmenden getippten Redaction-Token unverändert?
// Erzeugt KEINE großen Werte; n=12 genügt für den Nachweis des Rundlaufs. Ausgabe: data/f1-token-roundtrip-<ref>.json
import { writeFileSync } from 'node:fs';
import {
  createQaSession,
  hostHeaders,
  joinAs,
  nick,
  participantHeaders,
  query,
  submitQuestion,
} from './lib/trpc.mjs';

const ref = process.argv[2] ?? 'unknown';
const token = 'ARSNOVA_QA_REDACTED_RUN:12';
const text = `Frage mit Token ${token} Ende`;
const session = await createQaSession({ title: 'F1 Token-Rundlauf' });
const p = await joinAs(session.code, nick(0));
const submit = await submitQuestion(session, p, text);
// Beide Sichten: Moderationsliste der Lehrperson und Liste der Teilnehmenden.
const hostView = await query(
  'qa.list',
  { sessionId: session.sessionId, moderatorView: true },
  hostHeaders(session.hostToken),
);
const participantView = await query(
  'qa.list',
  { sessionId: session.sessionId, participantId: p.participantId },
  participantHeaders(p),
);
const list = hostView;
const stored = JSON.stringify(hostView.data ?? {}).includes(token);
const storedParticipant = JSON.stringify(participantView.data ?? {}).includes(token);
const result = {
  ref,
  submittedCodePoints: [...text].length,
  submitAccepted: Boolean(submit),
  listHttp: list.httpStatus,
  listCode: list.trpcCode,
  tokenStoredVerbatim: stored,
  participantViewHttp: participantView.httpStatus,
  tokenInParticipantView: storedParticipant,
};
writeFileSync(
  new URL(`../data/f1-token-roundtrip-${ref}.json`, import.meta.url),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
