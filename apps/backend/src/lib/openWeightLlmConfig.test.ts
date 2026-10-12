import { describe, expect, it } from 'vitest';
import {
  isOpenWeightLlmEnabled,
  isPrivateOpenWeightLlmAddress,
  resolveOpenWeightLlmConfig,
  resolveOpenWeightLlmSocketPath,
  resolveOpenWeightLlmUrl,
} from './openWeightLlmConfig';

describe('openWeightLlmConfig', () => {
  it('aktiviert die Runtime ausschließlich mit exakt true', () => {
    expect(isOpenWeightLlmEnabled('true')).toBe(true);
    expect(isOpenWeightLlmEnabled('TRUE')).toBe(false);
    expect(isOpenWeightLlmEnabled('1')).toBe(false);
    expect(isOpenWeightLlmEnabled(undefined)).toBe(false);
  });

  it('akzeptiert nur Basis-URLs ohne Credentials und sperrt bekannte SaaS-Ziele', () => {
    expect(resolveOpenWeightLlmUrl('http://10.20.30.40:8080')).toBe('http://10.20.30.40:8080');
    expect(resolveOpenWeightLlmUrl('http://runtime.internal:8080/')).toBe(
      'http://runtime.internal:8080',
    );
    expect(resolveOpenWeightLlmUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
    expect(resolveOpenWeightLlmUrl('http://[fd00::20]:8080')).toBe('http://[fd00::20]:8080');
    expect(() => resolveOpenWeightLlmUrl('ftp://10.20.30.40/model')).toThrow();
    expect(() => resolveOpenWeightLlmUrl('http://user:secret@10.20.30.40:8080')).toThrow();
    expect(() => resolveOpenWeightLlmUrl('http://10.20.30.40:8080/v1')).toThrow();
    expect(() => resolveOpenWeightLlmUrl('https://api.openai.com')).toThrow();
    expect(() => resolveOpenWeightLlmUrl('https://proxy.api.openai.com')).toThrow();
    expect(() => resolveOpenWeightLlmUrl('https://tenant.openai.azure.com')).toThrow();
  });

  it('erkennt ausschließlich Loopback, RFC1918 und ULA als private Zieladressen', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.7',
      '172.16.2.3',
      '172.31.255.254',
      '192.168.10.20',
      '::1',
      'fd12:3456::7',
      '[::1]',
      '[fd12:3456::7]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOpenWeightLlmAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '169.254.1.1', 'fe80::1', '2001:4860::8888']) {
      expect(isPrivateOpenWeightLlmAddress(address), address).toBe(false);
    }
  });

  it('validiert den Labor-Socket und verbietet zwei gleichzeitige Transporte', () => {
    expect(resolveOpenWeightLlmSocketPath('/run/open-weight-llm/llm.sock')).toBe(
      '/run/open-weight-llm/llm.sock',
    );
    expect(() => resolveOpenWeightLlmSocketPath('relative.sock')).toThrow();
    expect(() =>
      resolveOpenWeightLlmConfig({
        OPEN_WEIGHT_LLM_URL: 'http://127.0.0.1:8080',
        OPEN_WEIGHT_LLM_SOCKET_PATH: '/tmp/llm.sock',
      }),
    ).toThrow(/gegenseitig exklusiv/);
  });

  it('hält Kill-Switch, Credential und auftragsspezifische Budgets getrennt', () => {
    const config = resolveOpenWeightLlmConfig({
      OPEN_WEIGHT_LLM_ENABLED: 'true',
      OPEN_WEIGHT_LLM_URL: 'http://127.0.0.1:8080',
      OPEN_WEIGHT_LLM_TOKEN: 'runtime-secret-000000000000000000',
      OPEN_WEIGHT_LLM_LABEL_TIMEOUT_MS: '12000',
      OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_MS: '80000',
      OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_MS: '110000',
      NLP_ENABLED: 'false',
      QA_NLP_ENABLED: 'false',
      WORD_CLOUD_SEMANTIC_ENABLED: 'false',
      QA_SUMMARY_ENABLED: 'false',
    });
    expect(config.enabled).toBe(true);
    expect(config.token).toBe('runtime-secret-000000000000000000');
    expect(config.timeoutsMs).toEqual({
      topic_label: 12_000,
      qa_summary: 80_000,
      learning_objectives: 110_000,
    });
    expect(config.maxOutputTokens).toEqual({
      topic_label: 96,
      qa_summary: 640,
      learning_objectives: 768,
    });
  });

  it('reserviert für Lernziel-Batches standardmäßig fünf Minuten, ohne die kurzen Aufträge zu verlängern', () => {
    expect(resolveOpenWeightLlmConfig({}).timeoutsMs).toEqual({
      topic_label: 30_000,
      qa_summary: 90_000,
      learning_objectives: 300_000,
    });
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_MS: '300001' }),
    ).toThrow(/zwischen 1000 und 300000/);
  });

  it('verwirft zu kurze oder nicht URL-sichere Runtime-Credentials', () => {
    expect(() => resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: 'zu-kurz' })).toThrow(
      /32 bis 512/,
    );
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: `${'x'.repeat(32)}\ngeteilt` }),
    ).toThrow(/32 bis 512/);
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: `${'x'.repeat(32)} geteilt` }),
    ).toThrow(/URL-sichere ASCII/);
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: `${'x'.repeat(32)}ä` }),
    ).toThrow(/URL-sichere ASCII/);
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: `a,${'x'.repeat(32)}` }),
    ).toThrow(/URL-sichere ASCII/);
    expect(() =>
      resolveOpenWeightLlmConfig({ OPEN_WEIGHT_LLM_TOKEN: `"${'x'.repeat(32)}"` }),
    ).toThrow(/URL-sichere ASCII/);
  });
});
