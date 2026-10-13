/**
 * Kurze Themennamen nach dem Encoder-Lauf.
 * Der Schritt hält die Session-Queue nicht: der Aufrufer startet ihn erst,
 * nachdem `analyzeSemanticWordCloudSnapshot` das Slot freigegeben hat.
 */
import {
  OPEN_WEIGHT_LLM_MAX_REQUEST_BYTES,
  type AnalyzeWordCloudInput,
  type AnalyzeWordCloudOutput,
  type OpenWeightLlmTopicLabelOutput,
  type OpenWeightLlmTopicLabelRequest,
  type WordCloudAnalysisEntryDTO,
  type WordCloudLabelOrigin,
  type WordCloudLabelSettlement,
} from '@arsnova/shared-types';
import {
  isOpenWeightLlmEnabled,
  OPEN_WEIGHT_LLM_MODEL_ID,
  OPEN_WEIGHT_LLM_MODEL_VERSION,
  resolveOpenWeightLlmConfig,
} from './openWeightLlmConfig';
import { runOpenWeightLlmTopicLabel, type OpenWeightLlmLiveResult } from './openWeightLlmClient';
import { analyzeSemanticWordCloudSnapshot } from './wordCloudSemanticAnalyze';
import type { WordCloudNormalizationMeta } from './wordCloudNormalization';

export const WORD_CLOUD_TOPIC_LABEL_PHASE_BUDGET_MS = 8_000;
const TOPIC_LABEL_LOCALES = new Set(['de', 'en']);
const TRANSIENT_REASONS = new Set([
  'busy',
  'timeout',
  'aborted',
  'circuit_open',
  'unavailable',
  'misconfigured',
]);

export type TopicLabelCaller = (
  request: OpenWeightLlmTopicLabelRequest,
  fallback: OpenWeightLlmTopicLabelOutput,
  options: { readonly signal?: AbortSignal },
) => Promise<OpenWeightLlmLiveResult<OpenWeightLlmTopicLabelOutput>>;

type LabelOptions = {
  readonly now?: () => number;
  readonly label?: TopicLabelCaller;
  readonly env?: NodeJS.ProcessEnv;
};

function normalizeComparable(value: string): string {
  return value.trim().toLocaleLowerCase('de');
}

function wordCount(label: string): number {
  return label
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0).length;
}

function requestByteLength(request: OpenWeightLlmTopicLabelRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

function orderedMembers(entry: WordCloudAnalysisEntryDTO) {
  const central = normalizeComparable(entry.label);
  return [...entry.members].sort((left, right) => {
    const leftCentral = normalizeComparable(left.text) === central ? 0 : 1;
    const rightCentral = normalizeComparable(right.text) === central ? 0 : 1;
    if (leftCentral !== rightCentral) return leftCentral - rightCentral;
    if (left.text.length !== right.text.length) return left.text.length - right.text.length;
    return left.sourceId.localeCompare(right.sourceId);
  });
}

function packRequest(
  entry: WordCloudAnalysisEntryDTO,
  locale: AnalyzeWordCloudOutput['locale'],
  snapshotHash: string,
): OpenWeightLlmTopicLabelRequest | null {
  const members = orderedMembers(entry);
  const sources = members.map((member) => ({
    id: member.sourceId.slice(0, 80),
    text: member.text.trim().slice(0, 500),
  }));
  const clusterId = `${snapshotHash.slice(0, 16)}:${entry.key}`.slice(0, 80);
  let kept = sources;
  while (kept.length >= 2) {
    const request: OpenWeightLlmTopicLabelRequest = {
      schemaVersion: 1,
      taskType: 'topic_label',
      locale,
      clusterId,
      sources: kept,
    };
    if (requestByteLength(request) <= OPEN_WEIGHT_LLM_MAX_REQUEST_BYTES) {
      return request;
    }
    kept = kept.slice(0, -1);
  }
  return null;
}

function acceptLabel(label: string, sources: readonly { readonly text: string }[]): boolean {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (/[\r\n]/u.test(trimmed)) return false;
  if (wordCount(trimmed) > 6) return false;
  const comparable = normalizeComparable(trimmed);
  return sources.every((source) => normalizeComparable(source.text) !== comparable);
}

function withOrigin(
  entry: WordCloudAnalysisEntryDTO,
  origin: WordCloudLabelOrigin,
  label = entry.label,
): WordCloudAnalysisEntryDTO {
  return {
    ...entry,
    label,
    basisLabel: label,
    labelOrigin: origin,
  };
}

function runtimeEnabled(env: NodeJS.ProcessEnv): boolean {
  return isOpenWeightLlmEnabled(env['OPEN_WEIGHT_LLM_ENABLED']);
}

function labelTimeoutMs(env: NodeJS.ProcessEnv): number {
  try {
    return resolveOpenWeightLlmConfig(env).timeoutsMs.topic_label;
  } catch {
    return 30_000;
  }
}

export async function applyWordCloudTopicLabels(
  input: AnalyzeWordCloudInput,
  output: AnalyzeWordCloudOutput,
  options: LabelOptions = {},
): Promise<AnalyzeWordCloudOutput> {
  if (
    output.mode !== 'SEMANTIC' ||
    output.fallbackUsed ||
    (output.status !== 'ready' && output.status !== 'uncertain') ||
    (input.channel !== 'QA' && input.channel !== 'FREETEXT') ||
    !TOPIC_LABEL_LOCALES.has(output.locale)
  ) {
    return output;
  }

  const env = options.env ?? process.env;
  if (!runtimeEnabled(env)) {
    return {
      ...output,
      labelSettlement: 'disabled',
      labelModelId: null,
      labelModelVersion: null,
      entries: output.entries.map((entry) => withOrigin(entry, 'extractive')),
    };
  }

  const now = options.now ?? Date.now;
  const label = options.label ?? runOpenWeightLlmTopicLabel;
  const startedAt = now();
  const perCallCap = labelTimeoutMs(env);
  let transient = false;
  let acceptedModelLabel = false;
  const entries: WordCloudAnalysisEntryDTO[] = [];

  for (const entry of output.entries) {
    if (entry.members.length < 2) {
      entries.push(withOrigin(entry, 'extractive'));
      continue;
    }
    const remaining = WORD_CLOUD_TOPIC_LABEL_PHASE_BUDGET_MS - (now() - startedAt);
    if (remaining < 50) {
      transient = true;
      entries.push(withOrigin(entry, 'extractive'));
      continue;
    }
    const request = packRequest(entry, output.locale, output.snapshotHash);
    if (!request) {
      entries.push(withOrigin(entry, 'extractive'));
      continue;
    }
    const fallback: OpenWeightLlmTopicLabelOutput = {
      schemaVersion: 1,
      taskType: 'topic_label',
      label: entry.label.slice(0, 120),
      sourceIds: request.sources.slice(0, 8).map((source) => source.id),
    };
    const result = await label(request, fallback, {
      signal: AbortSignal.timeout(Math.min(perCallCap, remaining)),
    });
    if (result.status === 'completed' && acceptLabel(result.output.label, request.sources)) {
      acceptedModelLabel = true;
      entries.push(withOrigin(entry, 'model', result.output.label.trim()));
      continue;
    }
    if (result.status === 'fallback' && TRANSIENT_REASONS.has(result.reason)) {
      transient = true;
    }
    entries.push(withOrigin(entry, 'extractive'));
  }

  const labelSettlement: WordCloudLabelSettlement = transient ? 'transient' : 'complete';
  return {
    ...output,
    labelSettlement,
    labelModelId: acceptedModelLabel ? OPEN_WEIGHT_LLM_MODEL_ID : null,
    labelModelVersion: acceptedModelLabel ? OPEN_WEIGHT_LLM_MODEL_VERSION : null,
    entries,
  };
}

export async function labelSemanticWordCloudSnapshot(
  input: AnalyzeWordCloudInput,
  meta: WordCloudNormalizationMeta,
  options: LabelOptions & {
    readonly sessionId?: string;
    readonly tokensByItemId?: ReadonlyMap<
      string,
      readonly import('./wordCloudAnalysis').WordCloudRawToken[]
    >;
  } = {},
): Promise<AnalyzeWordCloudOutput> {
  const encoded = await analyzeSemanticWordCloudSnapshot(input, meta, options);
  return applyWordCloudTopicLabels(input, encoded, options);
}
