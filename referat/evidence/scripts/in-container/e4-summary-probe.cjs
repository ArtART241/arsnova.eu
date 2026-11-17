// E4/E5 (5B) – läuft IM App-Container der Laborinstanz (node - < datei, cwd /app/apps/backend).
// Nutzt den unveränderten 1.3-Code aus dist/: echte Kontextaufbereitung aus der DB,
// echter LLM-Client (Unix-Socket, Token, Slot-Probe, Schema-Prüfung) und echte Quellenbindung.
//
// MODE=baseline  → unveränderter Client (Instruktionen in zwei Systemnachrichten, Daten als JSON).
// MODE=variant   → LABOR-Gegenvariante: identischer Request, aber System- und Nutzdaten zu EINER
//                  unstrukturierten User-Nachricht verschmolzen (einzige veränderte Variable).
//
// Eingabe per Env: SESSION_ID, HOST_TOKEN, MODE. Ausgabe: genau eine JSON-Zeile auf stdout.
'use strict';
const http = require('node:http');
const { prepareFreshModerationSummaryContext } = require('./dist/lib/moderationSummaryContext.js');
const { resetOpenWeightLlmClientForTests } = require('./dist/lib/openWeightLlmClient.js');
const { runPreparedQaSummary } = require('./dist/lib/qaSummaryRuntimeAdapter.js');
const { bindQaSummaryModelOutputV2 } = require('./dist/lib/qaSummaryValidateV2.js');

const mode = process.env.MODE === 'variant' ? 'variant' : 'baseline';

function unixRequest(input, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: process.env.OPEN_WEIGHT_LLM_SOCKET_PATH,
        method: input.method,
        path: input.path,
        headers: {
          ...input.headers,
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        signal: input.signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Gegenvariante: Instruktion + Definition + Daten als ein einziger unstrukturierter Text. */
function flattenMessages(rawBody) {
  const parsed = JSON.parse(rawBody);
  const merged = parsed.messages.map((m) => m.content).join('\n\n');
  parsed.messages = [{ role: 'user', content: merged }];
  return JSON.stringify(parsed);
}

(async () => {
  const started = Date.now();
  // Beide Modi nutzen denselben Transport-Hook; nur der Variantenmodus verändert den Body.
  // Der Hook zeichnet die Rohantwort auf, damit „invalid_response" begründbar wird.
  const wire = { completionStatus: null, completionContent: null, finishReason: null, usage: null };
  resetOpenWeightLlmClientForTests({
    request: async (input) => {
      const isCompletion = input.path === '/v1/chat/completions';
      const body = isCompletion && mode === 'variant' ? flattenMessages(input.body) : input.body;
      const response = await unixRequest(input, body);
      if (isCompletion) {
        wire.completionStatus = response.status;
        try {
          const parsed = JSON.parse(response.body);
          wire.completionContent = parsed.choices?.[0]?.message?.content ?? null;
          wire.finishReason = parsed.choices?.[0]?.finish_reason ?? null;
          wire.usage = parsed.usage ?? null;
        } catch {
          wire.completionContent = response.body.slice(0, 4000);
        }
      }
      return response;
    },
  });
  const prepared = await prepareFreshModerationSummaryContext({
    sessionId: process.env.SESSION_ID,
    locale: 'de',
    access: { hostToken: process.env.HOST_TOKEN },
  });
  const ctx = prepared.request.promptContext;
  const packedQuestions = ctx.context.sources
    .filter((s) => s.kind === 'qa-question')
    .map((s) => ({
      id: s.id,
      text: s.content && s.content.state === 'included' ? s.content.text : null,
    }));
  const prepMs = Date.now() - started;

  const llmStarted = Date.now();
  // Produktionsadapter (qaSummaryRuntimeAdapter.ts:50-70): gleiche Entscheidung „full-context“
  // vs. extraktiver Fallback wie in der Queue; nur der 8-s-Wanduhr-Timeout der Queue entfällt.
  const run = await runPreparedQaSummary(prepared);
  const llmMs = Date.now() - llmStarted;
  const bound = bindQaSummaryModelOutputV2({
    output: run.output,
    prepared,
    execution: run.execution,
    analyzedAt: new Date().toISOString(),
  });
  const status =
    run.execution.effectiveMode === 'full-context'
      ? 'completed'
      : `fallback:${run.execution.fallback && run.execution.fallback.reason}`;
  process.stdout.write(
    JSON.stringify({
      mode,
      status,
      prepMs,
      llmMs,
      budget: ctx.budget,
      snapshotHash: ctx.snapshotHash,
      packedQuestions,
      rawOutput: run.execution.effectiveMode === 'full-context' ? run.output : null,
      wire,
      sourceKinds: [...new Set(ctx.context.sources.map((src) => src.kind))],
      bound,
    }) + '\n',
  );
})()
  .catch((error) => {
    process.stdout.write(
      JSON.stringify({ mode, status: 'harness_error', error: String(error && error.stack) }) + '\n',
    );
    process.exitCode = 1;
  })
  // Prisma- und Redis-Verbindungen halten den Prozess sonst offen.
  .finally(() => process.stdout.write('', () => process.exit(process.exitCode ?? 0)));
