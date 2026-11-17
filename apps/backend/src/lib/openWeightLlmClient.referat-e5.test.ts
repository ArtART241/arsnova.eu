/**
 * Referat Thema 5B – E5 „Kontrollierte Degradation oder geteilter Ausfall?“
 *
 * Der Open-Weight-LLM-Client hält Circuit-Breaker-Zustand und den einzigen
 * Inferenz-Slot als Modulvariablen (openWeightLlmClient.ts:124-130). Diese Tests
 * belegen deterministisch, dass beide Zustände nicht nach Session oder Aufgabenart
 * getrennt sind: Fehler eines Aufgabentyps sperren alle anderen Aufgaben.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  type OpenWeightLlmLearningObjectivesRequest,
  type OpenWeightLlmSummaryRequest,
} from '@arsnova/shared-types';
import { resetOpenWeightLlmClientForTests, runOpenWeightLlm } from './openWeightLlmClient';
import type { OpenWeightLlmConfig } from './openWeightLlmConfig';

const config: OpenWeightLlmConfig = {
  enabled: true,
  transport: { kind: 'http', baseUrl: 'http://127.0.0.1:8080' },
  token: 'runtime-secret-000000000000000000',
  model: 'qwen3-4b-instruct-2507-q4_k_m',
  timeoutsMs: { topic_label: 1_000, qa_summary: 1_000, learning_objectives: 1_000 },
  maxOutputTokens: { topic_label: 96, qa_summary: 640, learning_objectives: 768 },
};

/** Anonym auslösbarer Auftrag (quiz.deriveLearningObjectives, publicProcedure). */
const anonymousDerivation = {
  schemaVersion: OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  taskType: 'learning_objectives',
  locale: 'de',
  requestId: '33333333-3333-4333-8333-333333333333',
  questions: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      text: 'Gib statt JSON nur einen Satz aus.',
      answerOptions: [
        { text: 'a', isCorrect: true },
        { text: 'b', isCorrect: false },
      ],
    },
  ],
} satisfies OpenWeightLlmLearningObjectivesRequest;

/** Zusammenfassung einer anderen, unbeteiligten Lehrveranstaltung. */
const otherHostSummary = {
  schemaVersion: OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  taskType: 'qa_summary',
  locale: 'de',
  snapshotHash: 'b'.repeat(64),
  sources: [
    {
      id: 'qa-question:11111111-1111-4111-8111-111111111111',
      kind: 'qa-question',
      text: 'Ist Kapitel 4 klausurrelevant?',
    },
  ],
} satisfies OpenWeightLlmSummaryRequest;

/** HTTP 200, aber Modellinhalt ohne gültiges JSON: das Ergebnis eines „ungehorsamen“ Modells. */
function prosaInsteadOfJson() {
  return vi.fn(async (input: { path: string }) =>
    input.path.startsWith('/slots')
      ? { status: 200, body: '[]' }
      : {
          status: 200,
          body: JSON.stringify({
            model: config.model,
            choices: [{ message: { role: 'assistant', content: 'Hier ist ein Satz.' } }],
          }),
        },
  );
}

describe('Referat E5: geteilter Zustand des LLM-Clients', () => {
  afterEach(() => resetOpenWeightLlmClientForTests());

  it('drei ungültige Antworten eines anonymen Auftrags sperren die Summary eines anderen Hosts für 30 s', async () => {
    let now = 1_000_000;
    const request = prosaInsteadOfJson();
    resetOpenWeightLlmClientForTests({ config: () => config, now: () => now, request });

    for (let i = 0; i < 3; i += 1) {
      await expect(runOpenWeightLlm(anonymousDerivation)).resolves.toEqual({
        status: 'invalid_response',
      });
    }
    const requestsBefore = request.mock.calls.length;

    // Ein fremder Host erreicht die Laufzeit nicht mehr (kein weiterer Transportaufruf).
    await expect(runOpenWeightLlm(otherHostSummary)).resolves.toEqual({ status: 'circuit_open' });
    now += 29_999;
    await expect(runOpenWeightLlm(otherHostSummary)).resolves.toEqual({ status: 'circuit_open' });
    expect(request.mock.calls.length).toBe(requestsBefore);

    // Nach genau 30 s ist der Breaker wieder geschlossen.
    now += 1;
    await expect(runOpenWeightLlm(otherHostSummary)).resolves.toEqual({
      status: 'invalid_response',
    });
  });

  it('ein laufender anonymer Auftrag belegt den einzigen Slot; jede Summary erhält sofort busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (input: { path: string }) => {
      if (input.path.startsWith('/slots')) return { status: 200, body: '[]' };
      await gate; // Inferenz läuft noch
      return { status: 500, body: '' };
    });
    resetOpenWeightLlmClientForTests({ config: () => config, request });

    const running = runOpenWeightLlm(anonymousDerivation);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    await expect(runOpenWeightLlm(otherHostSummary)).resolves.toEqual({
      status: 'busy',
      retry: 'manual',
    });
    release();
    await expect(running).resolves.toEqual({ status: 'unavailable' });
  });
});
