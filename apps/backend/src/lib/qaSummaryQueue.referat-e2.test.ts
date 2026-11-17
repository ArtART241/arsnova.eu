/**
 * Referat Thema 5 / Einzelreferat „Eine Quelle verschwindet während der Analyse“ (E2).
 *
 * Deterministischer Verzögerungsadapter für den Lebenszyklus einer Quelle zwischen
 * autorisiertem Snapshot und Ergebnisanzeige. Baseline = unveränderter 1.3-Queuepfad
 * (Revalidierung nach der Inferenz und erneut vor der Auslieferung). Kontrollierte
 * Laborvariante = „nur Startprüfung“: Der beim Auftrag ermittelte Kontext wird für
 * alle späteren Prüfungen wiederverwendet. Die Variante existiert ausschließlich
 * in diesem Test (Hook-Injektion), nicht im Produktcode.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1,
  ModerationAnalysisContextV1Schema,
  QaSummaryExecutionV2Schema,
  type ModerationAnalysisContextV1,
} from '@arsnova/shared-types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  QA_SUMMARY_ADAPTER_CAPABILITIES,
  prepareModerationSummaryContextFromAnalysis,
  type PreparedModerationSummaryContext,
} from './moderationSummaryContext';
import type { QaSummaryConfig } from './qaSummaryConfig';
import {
  getQaSummaryRuntimeFresh,
  requestQaSummary,
  resetQaSummaryQueueForTests,
  waitForQaSummaryIdleForTests,
} from './qaSummaryQueue';

const SESSION_ID = '6a8edced-5f8f-4cfa-9176-454fac9570ad';
const ACCESS = { hostToken: 'host-token-e2' } as const;
/** Synthetischer Personenbezug, den eine moderierende Person während der Analyse schwärzt. */
const MARKER = 'Matrikelnummer 4711-GEHEIM';

const plan = {
  capabilities: QA_SUMMARY_ADAPTER_CAPABILITIES,
  selectedMode: 'full-context' as const,
  fallback: null,
  inferenceConfigured: true,
};

type Change = 'redaction' | 'benign-edit' | 'host-revoked';
type Timing = 'T1 vor Jobstart' | 'T2 während Inferenz' | 'T3 nach Abschluss, vor Anzeige';
type Variant = 'baseline-1.3' | 'variante-nur-startpruefung';

function analysisWith(mutator: (a: ModerationAnalysisContextV1) => void) {
  const clone = structuredClone(MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1);
  const analysis = ModerationAnalysisContextV1Schema.parse({
    schemaVersion: clone.schemaVersion,
    contractVersion: MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
    assembledAt: '2026-01-15T10:05:00.000Z',
    context: { ...clone.context, representation: 'analysis-candidates' },
  });
  mutator(analysis);
  return analysis;
}

function prepared(mutator: (a: ModerationAnalysisContextV1) => void) {
  return prepareModerationSummaryContextFromAnalysis({
    analysis: analysisWith(mutator),
    plan,
    packedAt: new Date('2026-01-15T10:06:00.000Z'),
  });
}

function setSourceTextOf(a: ModerationAnalysisContextV1, id: string, text: string) {
  for (const source of a.context.sources) {
    if (source.id === id && source.kind === 'qa-question' && 'content' in source) {
      (source.content as { text: string }).text = text;
    }
  }
}

function includedText(p: PreparedModerationSummaryContext, id: string): string | null {
  const source = p.request.promptContext.context.sources.find((s) => s.id === id);
  return source && 'content' in source && source.content.state === 'included'
    ? source.content.text
    : null;
}

/**
 * Zielquelle = die erste Frage, die das jeweilige Packprofil auch MIT angehängtem Marker
 * wörtlich in den Kontext aufnimmt (v1.3/4096: Frage C; upstream/main/Force-Fit: Frage E).
 * So prüft derselbe Test beide Stände, ohne eine Frage zu fixieren, die nie das Modell erreicht.
 */
const { SOURCE_F, ORIGINAL } = (() => {
  for (const source of analysisWith(() => undefined).context.sources) {
    if (source.kind !== 'qa-question' || !('content' in source)) continue;
    if (source.content.state !== 'included') continue;
    const original = source.content.text;
    const probe = prepared((a) => setSourceTextOf(a, source.id, `${original} ${MARKER}`));
    if (includedText(probe, source.id)?.includes(MARKER)) {
      return { SOURCE_F: source.id, ORIGINAL: original };
    }
  }
  throw new Error('Fixture packt keine Teilnehmerfrage samt Marker – E2 wäre gegenstandslos.');
})();

const setSourceText = (a: ModerationAnalysisContextV1, text: string) =>
  setSourceTextOf(a, SOURCE_F, text);

const BEFORE = prepared((a) => setSourceText(a, `${ORIGINAL} ${MARKER}`));
const AFTER: Record<Exclude<Change, 'host-revoked'>, PreparedModerationSummaryContext> = {
  redaction: prepared((a) => setSourceText(a, `${ORIGINAL} ███████████`)),
  // Reine Textkorrektur ohne Sicherheitsbezug (Tippfehler) – misst die Verfügbarkeitskosten
  // der Revalidierung. Eine synthetische Stimmenänderung ist hier nicht möglich, weil das
  // Kontextschema Best-Score/Kontroversität und Kompasssignale aus den Stimmen nachrechnet;
  // reale Stimmenänderungen werden live im Labor gemessen.
  'benign-edit': prepared((a) => setSourceText(a, `${ORIGINAL}? ${MARKER}`)),
};

function config(): QaSummaryConfig {
  return {
    enabled: true,
    timeoutMs: 5_000,
    queueLimit: 8,
    concurrency: 1,
    cooldownMs: 30_000,
    ttlMs: 1_800_000,
    maxSources: 20,
    inferenceUrl: null,
    inferenceToken: null,
  };
}

/**
 * Verzögerter Modelladapter: zitiert die Zielquelle wörtlich – aber nur so, wie sie
 * im tatsächlich übergebenen Kontext steht (ein Modell kennt nur seine Eingabe).
 */
function modelRun(input: PreparedModerationSummaryContext) {
  const source = input.request.promptContext.context.sources.find((s) => s.id === SOURCE_F);
  const quoted =
    source && 'content' in source && source.content.state === 'included'
      ? source.content.text
      : '(Quelle nicht im Kontext)';
  return {
    output: {
      status: 'ready' as const,
      statements: [
        {
          text: `Eine Person fragt: »${quoted}«`,
          sourceIds: [SOURCE_F],
        },
      ],
      suggestedNextSteps: [],
      limitations: [],
      modelVersion: 'delay-adapter',
    },
    execution: QaSummaryExecutionV2Schema.parse({
      attemptedMode: 'full-context',
      effectiveMode: 'full-context',
      fallback: null,
    }),
  };
}

const rows: Array<Record<string, unknown>> = [];

async function runCase(change: Change, timing: Timing, variant: Variant) {
  let current: PreparedModerationSummaryContext = BEFORE;
  let revoked = false;
  let startSnapshot: PreparedModerationSummaryContext | null = null;
  let releaseInference!: () => void;
  const inferenceGate = new Promise<void>((r) => (releaseInference = r));
  let scheduled: (() => void) | null = null;

  const applyChange = () => {
    if (change === 'host-revoked') revoked = true;
    else current = AFTER[change];
  };

  resetQaSummaryQueueForTests({
    config,
    plan: () => plan,
    prepare: async () => {
      if (variant === 'variante-nur-startpruefung' && startSnapshot) return startSnapshot;
      if (revoked) {
        throw Object.assign(new Error('Host access revoked'), { code: 'UNAUTHORIZED' });
      }
      startSnapshot ??= current;
      return current;
    },
    processor: async (input) => {
      if (timing === 'T2 während Inferenz') {
        applyChange();
      }
      await inferenceGate;
      return modelRun(input);
    },
    schedule: (fn) => {
      scheduled = fn;
    },
  });

  await requestQaSummary(SESSION_ID, 'de', ACCESS);
  if (timing === 'T1 vor Jobstart') applyChange();
  if (timing !== 'T2 während Inferenz') releaseInference();
  (scheduled as (() => void) | null)?.();
  if (timing === 'T2 während Inferenz') releaseInference();
  await waitForQaSummaryIdleForTests(2_000);
  if (timing === 'T3 nach Abschluss, vor Anzeige') applyChange();

  let delivered: unknown;
  let deliveryError: string | null = null;
  try {
    delivered = (await getQaSummaryRuntimeFresh(SESSION_ID, 'de', ACCESS)).result;
  } catch (error) {
    deliveryError = (error as { code?: string }).code ?? 'error';
  }
  const json = JSON.stringify(delivered ?? null);
  const result = delivered as
    { status?: string; execution?: { fallback?: { reason?: string } | null } } | null | undefined;
  const securityRelevant = change !== 'benign-edit';
  const leak = securityRelevant && json.includes(MARKER);
  rows.push({
    change,
    timing,
    variant,
    leak,
    status: result?.status ?? null,
    fallbackReason: result?.execution?.fallback?.reason ?? null,
    deliveryError,
  });
  return { leak, json, result, deliveryError };
}

const CHANGES: Change[] = ['redaction', 'host-revoked', 'benign-edit'];
const TIMINGS: Timing[] = [
  'T1 vor Jobstart',
  'T2 während Inferenz',
  'T3 nach Abschluss, vor Anzeige',
];

describe('Referat E2: Quelle verschwindet während der Analyse', () => {
  afterEach(() => resetQaSummaryQueueForTests());
  afterAll(() => {
    // REFERAT_E2_OUT erlaubt den Delta-Lauf auf upstream/main mit eigener Ausgabedatei.
    const out =
      process.env['REFERAT_E2_OUT'] ??
      resolve(__dirname, '../../../../referat/evidence/data/e2-lifecycle-unit.json');
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          experiment: 'E2',
          ref: process.env['REFERAT_REF'] ?? 'v1.3.0',
          target: SOURCE_F,
          marker: MARKER,
          rows,
        },
        null,
        2,
      ),
    );
  });

  it('Vorbedingung: die Zielquelle steht samt Marker wörtlich im Modellkontext', () => {
    const source = BEFORE.request.promptContext.context.sources.find((s) => s.id === SOURCE_F);
    expect(source && 'content' in source && source.content.state === 'included').toBe(true);
    expect(JSON.stringify(source)).toContain(MARKER);
  });

  for (const change of CHANGES.filter((c) => c !== 'benign-edit')) {
    for (const timing of TIMINGS) {
      it(`Baseline 1.3 liefert nach ${change} (${timing}) keinen alten Inhalt aus`, async () => {
        const { leak } = await runCase(change, timing, 'baseline-1.3');
        expect(leak).toBe(false);
      });
    }
  }

  it('Baseline: Schwärzung während der Inferenz führt zu source_changed statt Modellaussage', async () => {
    const { result } = await runCase('redaction', 'T2 während Inferenz', 'baseline-1.3');
    expect(result).toMatchObject({ execution: { fallback: { reason: 'source_changed' } } });
  });

  it('Kosten der Revalidierung: auch eine harmlose Textkorrektur verwirft das Modellergebnis', async () => {
    const { result } = await runCase('benign-edit', 'T2 während Inferenz', 'baseline-1.3');
    expect(result).toMatchObject({ execution: { fallback: { reason: 'source_changed' } } });
  });

  for (const change of CHANGES.filter((c) => c !== 'benign-edit')) {
    for (const timing of TIMINGS) {
      it(`Laborvariante „nur Startprüfung“ liefert nach ${change} (${timing}) Altinhalt aus`, async () => {
        const { leak } = await runCase(change, timing, 'variante-nur-startpruefung');
        // Gegenprobe: Ohne Revalidierung nach Inferenz und vor Anzeige liefert die
        // Variante den beim Auftrag eingefrorenen Altinhalt in jedem Zeitpunkt aus.
        expect(leak).toBe(true);
      });
    }
  }
});
