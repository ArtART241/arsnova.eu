import { describe, expect, it } from 'vitest';
import { renderWordCloudTooltipMarkdown } from './word-cloud-markdown-tooltip.directive';

describe('renderWordCloudTooltipMarkdown', () => {
  it('rendert Markdown und KaTeX statt der Rohzeichen', () => {
    const html = renderWordCloudTooltipMarkdown('**Steigung** $a^2$');
    expect(html).toContain('<strong>Steigung</strong>');
    expect(html).toContain('katex');
    expect(html).not.toContain('$a^2$');
  });
});
