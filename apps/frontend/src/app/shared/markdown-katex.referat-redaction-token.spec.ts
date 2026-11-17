/**
 * Referat Thema 5B – Kandidat „Redaction-Token in Teilnehmertext“.
 *
 * `sanitizeMarkdownHtml` ersetzt nach DOMPurify interne Platzhalter
 * (`ARSNOVA_QA_REDACTED_RUN:<n>`) durch n Span-Elemente. Wenn ein
 * Teilnehmer diesen Token selbst in seine Frage schreibt, bestimmt er n.
 * Der Test belegt die Erreichbarkeit mit kleinen n und misst das Wachstum;
 * er erzeugt bewusst KEINE großen Werte, die die Testmaschine einfrieren würden.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdownWithKatex } from './markdown-katex.util';

const token = (n: number) => `ARSNOVA_QA_REDACTED_RUN:${n}`;
const countSpans = (html: string) => (html.match(/class="qa-redacted-char"/g) ?? []).length;

describe('Referat 5B: Redaction-Token aus Teilnehmertext', () => {
  it('ein vom Nutzer getippter Token überlebt Markdown und DOMPurify und wird expandiert', () => {
    const html = renderMarkdownWithKatex(`Frage ${token(7)} Ende`).html;
    expect(countSpans(html)).toBe(7);
  });

  it('die Anzahl erzeugter DOM-Elemente skaliert linear mit der vom Nutzer gewählten Zahl', () => {
    const samples: Array<{ n: number; spans: number; htmlBytes: number; ms: number }> = [];
    for (const n of [1_000, 10_000, 100_000]) {
      const started = performance.now();
      const html = renderMarkdownWithKatex(`x ${token(n)}`).html;
      samples.push({
        n,
        spans: countSpans(html),
        htmlBytes: html.length,
        ms: Math.round(performance.now() - started),
      });
    }
    // eslint-disable-next-line no-console
    console.log('REFERAT_REDACTION_TOKEN_SAMPLES', JSON.stringify(samples));
    for (const s of samples) expect(s.spans).toBe(s.n);
    // 7 Zeichen Token-Ziffern (z. B. "9999999") würden ~10^7 Spans (≈ 0,6 GB HTML) bedeuten.
    expect(samples[2]!.htmlBytes / samples[2]!.n).toBeGreaterThan(50);
  });
});
