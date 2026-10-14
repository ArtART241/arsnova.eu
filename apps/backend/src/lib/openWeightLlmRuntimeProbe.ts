/**
 * Minimale Betriebsstichprobe der drei privaten LLM-Aufträge.
 * Läuft nicht im Footer-Poll; globales Intervall schützt den Inferenz-Slot auch bei refresh.
 */
import {
  MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1,
  MODERATION_PROMPT_DEFINITION_SET_VERSION,
  OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  OpenWeightLlmRuntimeProbeSchema,
  QA_SUMMARY_CONTEXT_V2_CONTRACT_VERSION,
  QA_SUMMARY_MODEL_OUTPUT_V2_CONTRACT_VERSION,
  QA_SUMMARY_TECHNICAL_INSTRUCTION_VERSION,
  QA_SUMMARY_V2_SCHEMA_VERSION,
  type OpenWeightLlmLearningObjectivesRequest,
  type OpenWeightLlmRuntimeProbeDTO,
  type OpenWeightLlmProbeTaskResult,
  type OpenWeightLlmProbeTaskStatus,
  type OpenWeightLlmSummaryRequestV2,
  type OpenWeightLlmTopicLabelOutput,
  type OpenWeightLlmTopicLabelRequest,
} from '@arsnova/shared-types';
import { isOpenWeightLlmEnabled, OPEN_WEIGHT_LLM_MODEL_ALIAS } from './openWeightLlmConfig';
import {
  runOpenWeightLlmLearningObjectives,
  runOpenWeightLlmSummaryV2,
  runOpenWeightLlmTopicLabel,
} from './openWeightLlmClient';
import {
  QA_SUMMARY_TECHNICAL_DEFINITION_TEXT,
  QA_SUMMARY_TECHNICAL_INSTRUCTION_TEXT,
} from './moderationSummaryContext';

/** Ergebnis-Cache und Mindestabstand zwischen Live-Messungen (auch bei refresh). */
export const OPEN_WEIGHT_LLM_PROBE_CACHE_TTL_MS = 5 * 60_000;
/** Pro Aufgabe bewusst kürzer als die Produktions-Timeouts — nur Erreichbarkeit/Schema. */
export const OPEN_WEIGHT_LLM_PROBE_TASK_TIMEOUT_MS = 20_000;

const PROBE_SOURCE_ID = 'probe-s1';
const PROBE_QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const PROBE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';

const TOPIC_LABEL_REQUEST = {
  schemaVersion: OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  taskType: 'topic_label',
  locale: 'de',
  clusterId: 'ops-probe-topic-label',
  sources: [
    { id: PROBE_SOURCE_ID, text: 'Was ist die Steigung der Geraden y = 2x + 1?' },
    {
      id: 'probe-s2',
      text: 'Bestimme die lineare Funktion durch die Punkte (0, 1) und (2, 5).',
    },
  ],
} satisfies OpenWeightLlmTopicLabelRequest;

const TOPIC_LABEL_FALLBACK = {
  schemaVersion: OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  taskType: 'topic_label',
  label: 'Probe',
  sourceIds: [PROBE_SOURCE_ID],
} satisfies OpenWeightLlmTopicLabelOutput;

const LEARNING_REQUEST = {
  schemaVersion: OPEN_WEIGHT_LLM_SCHEMA_VERSION,
  taskType: 'learning_objectives',
  locale: 'de',
  requestId: PROBE_REQUEST_ID,
  questions: [
    {
      id: PROBE_QUESTION_ID,
      text: 'Welche Gerade beschreibt y = 2x + 1?',
      answerOptions: [
        { text: 'Steigung 2, Achsenabschnitt 1', isCorrect: true },
        { text: 'Steigung 1, Achsenabschnitt 2', isCorrect: false },
      ],
    },
  ],
} satisfies OpenWeightLlmLearningObjectivesRequest;

function buildSummaryV2ProbeRequest(): OpenWeightLlmSummaryRequestV2 {
  const instructionText = QA_SUMMARY_TECHNICAL_INSTRUCTION_TEXT;
  const definitionText = QA_SUMMARY_TECHNICAL_DEFINITION_TEXT;
  const instructionTokens = new TextEncoder().encode(instructionText).byteLength;
  const definitionTokens = new TextEncoder().encode(definitionText).byteLength;
  const promptContext = structuredClone(MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1);
  const dataTokens = promptContext.budget.dataTokens;
  const packedInputTokens = instructionTokens + definitionTokens + dataTokens;
  const reserved =
    promptContext.budget.reservedOutputTokens + promptContext.budget.safetyMarginTokens;
  promptContext.budget = {
    ...promptContext.budget,
    instructionTokens,
    definitionTokens,
    packedInputTokens,
    contextWindowTokens: Math.max(
      promptContext.budget.contextWindowTokens,
      packedInputTokens + reserved,
    ),
  };
  return {
    schemaVersion: QA_SUMMARY_V2_SCHEMA_VERSION,
    taskType: 'qa_summary',
    requestContract: QA_SUMMARY_CONTEXT_V2_CONTRACT_VERSION,
    outputContract: QA_SUMMARY_MODEL_OUTPUT_V2_CONTRACT_VERSION,
    instructionVersion: QA_SUMMARY_TECHNICAL_INSTRUCTION_VERSION,
    instructionText,
    definitionVersion: MODERATION_PROMPT_DEFINITION_SET_VERSION,
    definitionText,
    promptContext,
  };
}

const SUMMARY_V2_REQUEST = buildSummaryV2ProbeRequest();

type ProbeHooks = {
  readonly now?: () => number;
  readonly topicLabel?: typeof runOpenWeightLlmTopicLabel;
  readonly summaryV2?: typeof runOpenWeightLlmSummaryV2;
  readonly learning?: typeof runOpenWeightLlmLearningObjectives;
  readonly env?: NodeJS.ProcessEnv;
  readonly taskTimeoutMs?: number;
};

let cachedProbe: { value: OpenWeightLlmRuntimeProbeDTO; expiresAt: number } | null = null;
let probeInFlight: Promise<OpenWeightLlmRuntimeProbeDTO> | null = null;

function disabledTask(): OpenWeightLlmProbeTaskResult {
  return { status: 'disabled', elapsedMs: null, reason: 'disabled' };
}

function disabledProbe(checkedAt: string): OpenWeightLlmRuntimeProbeDTO {
  return OpenWeightLlmRuntimeProbeSchema.parse({
    enabled: false,
    overall: 'disabled',
    checkedAt,
    cache: 'skipped',
    modelAlias: null,
    modelReported: null,
    tasks: {
      topic_label: disabledTask(),
      qa_summary: disabledTask(),
      learning_objectives: disabledTask(),
    },
  });
}

function mapFailureReason(reason: string): OpenWeightLlmProbeTaskStatus {
  switch (reason) {
    case 'busy':
      return 'busy';
    case 'disabled':
      return 'disabled';
    case 'invalid_response':
      return 'degraded';
    case 'timeout':
    case 'aborted':
    case 'circuit_open':
    case 'unavailable':
    case 'misconfigured':
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

function overallFromTasks(
  tasks: OpenWeightLlmRuntimeProbeDTO['tasks'],
): OpenWeightLlmProbeTaskStatus {
  const statuses = [
    tasks.topic_label.status,
    tasks.qa_summary.status,
    tasks.learning_objectives.status,
  ];
  if (statuses.every((status) => status === 'disabled')) return 'disabled';
  if (statuses.every((status) => status === 'ok')) return 'ok';
  if (statuses.every((status) => status === 'unknown')) return 'unknown';
  if (
    statuses.some((status) => status === 'busy') &&
    statuses.every((status) => status === 'busy' || status === 'ok')
  ) {
    return 'busy';
  }
  if (statuses.some((status) => status === 'ok')) return 'degraded';
  if (statuses.some((status) => status === 'busy')) return 'busy';
  return 'unavailable';
}

type TaskRunOutcome = {
  readonly status: string;
  readonly reason?: string;
  readonly model?: string | null;
};

async function runOneTask(
  run: () => Promise<TaskRunOutcome>,
  now: () => number,
): Promise<OpenWeightLlmProbeTaskResult & { readonly model: string | null }> {
  const startedAt = now();
  try {
    const result = await run();
    const elapsedMs = Math.max(0, Math.round(now() - startedAt));
    const model =
      typeof result.model === 'string' && result.model.trim().length > 0
        ? result.model.trim().slice(0, 256)
        : null;
    if (result.status === 'completed') {
      return { status: 'ok', elapsedMs, reason: null, model };
    }
    const reason = result.reason ?? result.status;
    return {
      status: mapFailureReason(reason),
      elapsedMs,
      reason: reason.slice(0, 64),
      model: null,
    };
  } catch {
    return {
      status: 'unavailable',
      elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      reason: 'error',
      model: null,
    };
  }
}

async function measureProbe(hooks: ProbeHooks): Promise<OpenWeightLlmRuntimeProbeDTO> {
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  if (!isOpenWeightLlmEnabled(env['OPEN_WEIGHT_LLM_ENABLED'])) {
    return disabledProbe(checkedAt);
  }

  const timeoutMs = hooks.taskTimeoutMs ?? OPEN_WEIGHT_LLM_PROBE_TASK_TIMEOUT_MS;
  const topicLabel = hooks.topicLabel ?? runOpenWeightLlmTopicLabel;
  const summaryV2 = hooks.summaryV2 ?? runOpenWeightLlmSummaryV2;
  const learning = hooks.learning ?? runOpenWeightLlmLearningObjectives;

  const topic = await runOneTask(async () => {
    const result = await topicLabel(TOPIC_LABEL_REQUEST, TOPIC_LABEL_FALLBACK, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.status === 'completed'
      ? { status: 'completed', model: result.telemetry.model }
      : { status: 'fallback', reason: result.reason };
  }, now);

  const qaSummary = await runOneTask(async () => {
    const result = await summaryV2(SUMMARY_V2_REQUEST, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.status === 'completed'
      ? { status: 'completed', model: result.telemetry.model }
      : { status: result.status, reason: result.status };
  }, now);

  const learningObjectives = await runOneTask(async () => {
    const result = await learning(LEARNING_REQUEST, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result.status === 'completed'
      ? { status: 'completed', model: result.telemetry.model }
      : { status: result.status, reason: result.status };
  }, now);

  const tasks = {
    topic_label: {
      status: topic.status,
      elapsedMs: topic.elapsedMs,
      reason: topic.reason,
    },
    qa_summary: {
      status: qaSummary.status,
      elapsedMs: qaSummary.elapsedMs,
      reason: qaSummary.reason,
    },
    learning_objectives: {
      status: learningObjectives.status,
      elapsedMs: learningObjectives.elapsedMs,
      reason: learningObjectives.reason,
    },
  };
  const modelReported = topic.model ?? qaSummary.model ?? learningObjectives.model ?? null;

  return OpenWeightLlmRuntimeProbeSchema.parse({
    enabled: true,
    overall: overallFromTasks(tasks),
    checkedAt,
    cache: 'live',
    modelAlias: OPEN_WEIGHT_LLM_MODEL_ALIAS,
    modelReported,
    tasks,
  });
}

export function resetOpenWeightLlmRuntimeProbeForTests(): void {
  cachedProbe = null;
  probeInFlight = null;
}

/** Exported for contract tests — same V2 request the live probe sends. */
export function getOpenWeightLlmSummaryV2ProbeRequestForTests(): OpenWeightLlmSummaryRequestV2 {
  return SUMMARY_V2_REQUEST;
}

export async function getOpenWeightLlmRuntimeProbe(
  options: ProbeHooks & { readonly refresh?: boolean } = {},
): Promise<OpenWeightLlmRuntimeProbeDTO> {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  if (!isOpenWeightLlmEnabled(env['OPEN_WEIGHT_LLM_ENABLED'])) {
    const value = disabledProbe(new Date(now()).toISOString());
    cachedProbe = { value, expiresAt: now() + OPEN_WEIGHT_LLM_PROBE_CACHE_TTL_MS };
    return value;
  }

  // refresh darf den Cache/Cooldownkühlzeit nicht umgehen — sonst belegt jeder anonyme
  // Aufruf den einzigen Inferenz-Slot erneut (Shared-NAT-tauglich, kein IP-Budget-Senken).
  if (cachedProbe && cachedProbe.expiresAt > now()) {
    return OpenWeightLlmRuntimeProbeSchema.parse({
      ...cachedProbe.value,
      cache: 'fresh',
    });
  }

  if (probeInFlight) {
    return probeInFlight;
  }

  probeInFlight = measureProbe(options)
    .then((value) => {
      cachedProbe = { value, expiresAt: now() + OPEN_WEIGHT_LLM_PROBE_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      probeInFlight = null;
    });

  return probeInFlight;
}
