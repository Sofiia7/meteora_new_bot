import { describe, it, expect } from 'vitest';
import {
  evaluateSecurity,
  GmgnData,
  RugcheckData,
  BubbleMapsData,
} from '../src/services/security';

const cleanGmgn = (): GmgnData => ({ available: true, totalFeesSol: 100, hasTwitter: true });
const cleanRug = (): RugcheckData => ({
  available: true,
  riskScore: 7, // низкий риск = безопасно
  hasDanger: false,
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
});
const cleanBm = (): BubbleMapsData => ({ available: true, decentralisationScore: 45 });

describe('evaluateSecurity', () => {
  it('чистый токен (как BONK) проходит с высоким скором', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), cleanBm());
    expect(r.passed).toBe(true);
    expect(r.hardFail).toBe(false);
    expect(r.score).toBe(100);
  });

  it('GMGN недоступен (403 на VPS) НЕ валит легитимный токен — ключевой фикс', () => {
    const r = evaluateSecurity({ available: false, totalFeesSol: 0, hasTwitter: false }, cleanRug(), cleanBm());
    expect(r.sourcesUnavailable).toContain('GMGN');
    expect(r.passed).toBe(true); // BONK-кейс: GMGN заблокирован, но токен проходит
    expect(r.score).toBe(100);
  });

  it('низкий RugCheck risk = Good (score_normalised это РИСК, не качество)', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), riskScore: 7 }, cleanBm());
    expect(r.rugcheckStatus).toBe('Good');
    expect(r.passed).toBe(true);
  });

  it('высокий RugCheck risk штрафует и валит', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), riskScore: 85, hasDanger: true }, cleanBm());
    expect(r.score).toBeLessThan(60);
    expect(r.passed).toBe(false);
  });

  it('honeypot — жёсткий провал', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), honeypot: true }, cleanBm());
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('активная mint authority — жёсткий провал', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), mintAuthorityActive: true }, cleanBm());
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('низкая децентрализация BubbleMaps штрафует', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), { available: true, decentralisationScore: 8 });
    expect(r.score).toBeLessThan(100);
    expect(r.decentralisationScore).toBe(8);
  });

  it('BubbleMaps недоступен — fail-closed (штраф + decentralisation 0)', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), { available: false, decentralisationScore: 0 });
    expect(r.sourcesUnavailable).toContain('BubbleMaps');
    expect(r.decentralisationScore).toBe(0);
    expect(r.score).toBeLessThan(100);
  });

  it('RugCheck + BubbleMaps недоступны одновременно — проваливается (fail-closed)', () => {
    const r = evaluateSecurity(
      { available: false, totalFeesSol: 0, hasTwitter: false },
      { available: false, riskScore: null, hasDanger: false, honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false },
      { available: false, decentralisationScore: 0 }
    );
    expect(r.passed).toBe(false);
    expect(r.sourcesUnavailable).toEqual(['GMGN', 'RugCheck', 'BubbleMaps']);
  });
});
