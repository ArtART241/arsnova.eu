import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenWeightLlmRuntimeProbe,
  resetOpenWeightLlmRuntimeProbeForTests,
} from './openWeightLlmRuntimeProbe';

const enabledEnv = {
  OPEN_WEIGHT_LLM_ENABLED: 'true',
  OPEN_WEIGHT_LLM_URL: 'http://127.0.0.1:8080',
  OPEN_WEIGHT_LLM_TOKEN: 'a'.repeat(32),
} as NodeJS.ProcessEnv;

afterEach(() => {
  resetOpenWeightLlmRuntimeProbeForTests();
});

describe('getOpenWeightLlmRuntimeProbe', () => {
  it('meldet disabled ohne Runtime-Aufruf', async () => {
    const topicLabel = vi.fn();
    const result = await getOpenWeightLlmRuntimeProbe({
      env: { OPEN_WEIGHT_LLM_ENABLED: 'false' },
      topicLabel,
    });
    expect(result.enabled).toBe(false);
    expect(result.overall).toBe('disabled');
    expect(result.cache).toBe('skipped');
    expect(result.modelAlias).toBeNull();
    expect(result.modelReported).toBeNull();
    expect(result.tasks.topic_label.status).toBe('disabled');
    expect(topicLabel).not.toHaveBeenCalled();
  });

  it('prüft die drei Aufgaben und cached das Ergebnis', async () => {
    const topicLabel = vi.fn(async () => ({
      status: 'completed' as const,
      output: {
        schemaVersion: 1 as const,
        taskType: 'topic_label' as const,
        label: 'lineare Funktionen',
        sourceIds: ['probe-s1'],
      },
      telemetry: {
        taskType: 'topic_label' as const,
        elapsedMs: 12,
        model: 'qwen3-4b-instruct-2507-q4_k_m',
        promptTokens: null,
        completionTokens: null,
      },
    }));
    const summary = vi.fn(async () => ({
      status: 'completed' as const,
      output: {
        schemaVersion: 1 as const,
        taskType: 'qa_summary' as const,
        result: {
          status: 'ready' as const,
          statements: [{ text: 'Kapitel 4', sourceIds: ['probe-s1'] }],
          suggestedNextSteps: [],
          limitations: [],
          modelVersion: 'probe',
        },
      },
      telemetry: {
        taskType: 'qa_summary' as const,
        elapsedMs: 20,
        model: 'qwen3-4b-instruct-2507-q4_k_m',
        promptTokens: null,
        completionTokens: null,
      },
    }));
    const learning = vi.fn(async () => ({
      status: 'completed' as const,
      output: {
        schemaVersion: 1 as const,
        taskType: 'learning_objectives' as const,
        objectives: [
          {
            text: 'Lineare Funktionen interpretieren',
            questionIds: ['11111111-1111-4111-8111-111111111111'],
          },
        ],
        limitations: [],
      },
      telemetry: {
        taskType: 'learning_objectives' as const,
        elapsedMs: 30,
        model: 'qwen3-4b-instruct-2507-q4_k_m',
        promptTokens: null,
        completionTokens: null,
      },
    }));

    const first = await getOpenWeightLlmRuntimeProbe({
      env: enabledEnv,
      topicLabel: topicLabel as never,
      summary: summary as never,
      learning: learning as never,
    });
    expect(first.overall).toBe('ok');
    expect(first.cache).toBe('live');
    expect(first.modelAlias).toBe('qwen3-4b-instruct-2507-q4_k_m');
    expect(first.modelReported).toBe('qwen3-4b-instruct-2507-q4_k_m');
    expect(first.tasks.topic_label.status).toBe('ok');
    expect(first.tasks.qa_summary.status).toBe('ok');
    expect(first.tasks.learning_objectives.status).toBe('ok');
    expect(topicLabel).toHaveBeenCalledTimes(1);

    const second = await getOpenWeightLlmRuntimeProbe({
      env: enabledEnv,
      topicLabel: topicLabel as never,
      summary: summary as never,
      learning: learning as never,
    });
    expect(second.cache).toBe('fresh');
    expect(topicLabel).toHaveBeenCalledTimes(1);
  });

  it('ordnet busy und Teilausfälle dem Gesamtstatus zu', async () => {
    const result = await getOpenWeightLlmRuntimeProbe({
      env: enabledEnv,
      topicLabel: (async () => ({
        status: 'fallback' as const,
        reason: 'busy',
        output: {
          schemaVersion: 1 as const,
          taskType: 'topic_label' as const,
          label: 'Probe',
          sourceIds: ['probe-s1'],
        },
      })) as never,
      summary: (async () => ({
        status: 'completed' as const,
        output: {
          schemaVersion: 1 as const,
          taskType: 'qa_summary' as const,
          result: {
            status: 'ready' as const,
            statements: [{ text: 'Kapitel 4', sourceIds: ['probe-s1'] }],
            suggestedNextSteps: [],
            limitations: [],
            modelVersion: 'probe',
          },
        },
        telemetry: {
          taskType: 'qa_summary' as const,
          elapsedMs: 1,
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
      })) as never,
      learning: (async () => ({ status: 'busy' as const, retry: 'manual' as const })) as never,
    });
    expect(result.tasks.topic_label.status).toBe('busy');
    expect(result.tasks.qa_summary.status).toBe('ok');
    expect(result.tasks.learning_objectives.status).toBe('busy');
    expect(result.overall).toBe('busy');
  });
});
