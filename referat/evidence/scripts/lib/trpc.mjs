// Minimal tRPC-v11-HTTP-Client für die Laborinstanz (kein Transformer, reines JSON).
// LABOR: zielt ausschließlich auf 127.0.0.1 – niemals auf arsnova.eu.
import { randomUUID, randomBytes } from 'node:crypto';

export const BASE_URL = process.env.LAB_BASE_URL ?? 'http://127.0.0.1:3000';

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE_URL)) {
  throw new Error(`Abbruch: LAB_BASE_URL muss lokal sein, ist aber ${BASE_URL}`);
}

/**
 * Ruft eine Prozedur auf und liefert IMMER ein Protokollobjekt zurück
 * (kein throw bei tRPC-Fehlern), damit Negativtests Statuscodes messen können.
 */
export async function call(kind, procedure, input, headers = {}) {
  const started = performance.now();
  const url =
    kind === 'query'
      ? `${BASE_URL}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${BASE_URL}/trpc/${procedure}`;
  const send = () =>
    fetch(url, {
      method: kind === 'query' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: kind === 'query' ? undefined : JSON.stringify(input),
    });
  let res;
  try {
    res = await send();
  } catch (error) {
    // Der Server schließt Keep-alive-Sockets nach Leerlauf (z. B. während eines 15-s-Modelllaufs).
    // Einmaliger Neuversuch nur bei Transportfehlern; tRPC-Fehler werden nie wiederholt.
    if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
    res = await send();
  }
  const raw = await res.text();
  const ms = Math.round(performance.now() - started);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { unparsable: raw.slice(0, 200) };
  }
  return {
    procedure,
    httpStatus: res.status,
    trpcCode: body?.error?.data?.code ?? null,
    message: body?.error?.message ?? null,
    data: body?.result?.data ?? null,
    responseBytes: Buffer.byteLength(raw),
    ms,
  };
}

export const query = (p, i, h) => call('query', p, i, h);
export const mutate = (p, i, h) => call('mutation', p, i, h);

export function unwrap(r) {
  if (r.trpcCode || r.httpStatus >= 400) {
    throw new Error(`${r.procedure} fehlgeschlagen: ${r.httpStatus} ${r.trpcCode} ${r.message}`);
  }
  return r.data;
}

/** Legt eine Q&A-Session an (ohne Vorab-Moderation, damit Fragen ACTIVE werden). */
export async function createQaSession({ moderation = false, title = 'Labor 5A' } = {}) {
  const created = unwrap(
    await mutate('session.create', {
      type: 'Q_AND_A',
      title,
      moderationMode: moderation,
      qaModerationMode: moderation,
    }),
  );
  return {
    sessionId: created.sessionId,
    code: created.code,
    hostToken: created.hostToken,
    hostBrowserCapability: created.hostBrowserCapability,
  };
}

/**
 * Pseudonyme aus der Kindergarten-Liste (libs/shared-types/src/kindergarten-nicknames.ts).
 * Ab upstream/main erzwingt participantJoin.ts:395 für neue Q&A-Sessions die Liste;
 * die Namen sind auch unter v1.3 gültig.
 */
const LAB_NICKNAMES = [
  'Drache',
  'Delfin',
  'Schmetterling',
  'Wal',
  'Leopard',
  'Hase',
  'Auster',
  'Dodo',
  'Papagei',
  'Schwan',
];
export const nick = (i) => LAB_NICKNAMES[i % LAB_NICKNAMES.length];

export async function joinAs(code, nickname) {
  const joined = unwrap(
    await mutate('session.join', {
      code,
      nickname,
      anonymousClientId: randomUUID(),
      joinIdempotencyKey: randomBytes(32).toString('base64url'),
    }),
  );
  return { participantId: joined.participantId, capability: joined.rejoinToken };
}

export async function submitQuestion(session, participant, text) {
  const r = await mutate(
    'qa.submit',
    {
      sessionId: session.sessionId,
      participantId: participant.participantId,
      text,
      idempotencyKey: randomUUID(),
    },
    { 'x-participant-capability': participant.capability },
  );
  return unwrap(r);
}

export const hostHeaders = (token) => ({ 'x-host-token': token });
export const participantHeaders = (p) => ({ 'x-participant-capability': p.capability });
