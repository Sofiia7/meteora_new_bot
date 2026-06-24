import { describe, it, expect } from 'vitest';
import {
  evaluateSecurity,
  GmgnData,
  RugcheckData,
  BubbleMapsData,
} from '../src/services/security';

const cleanGmgn = (): GmgnData => ({
  available: true,
  totalFeesSol: 100,
  hasTwitter: true,
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
});
const cleanRug = (): RugcheckData => ({
  available: true,
  scoreNormalised: 95,
  level: 'good',
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
});
const cleanBm = (): BubbleMapsData => ({ available: true, topHoldersPercent: 20 });

describe('evaluateSecurity', () => {
  it('чистый токен проходит со 100/100', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), cleanBm());
    expect(r.passed).toBe(true);
    expect(r.hardFail).toBe(false);
    expect(r.score).toBe(100);
  });

  it('honeypot — жёсткий провал', () => {
    const r = evaluateSecurity({ ...cleanGmgn(), honeypot: true }, cleanRug(), cleanBm());
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.honeypot).toBe(true);
  });

  it('активная mint authority — жёсткий провал', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), mintAuthorityActive: true }, cleanBm());
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('RugCheck danger — жёсткий провал', () => {
    const r = evaluateSecurity(cleanGmgn(), { ...cleanRug(), level: 'danger' }, cleanBm());
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('нет Twitter — только мягкий минус, токен всё ещё проходит', () => {
    const r = evaluateSecurity({ ...cleanGmgn(), hasTwitter: false }, cleanRug(), cleanBm());
    expect(r.passed).toBe(true);
    expect(r.score).toBe(90);
    expect(r.twitterActive).toBe(false);
  });

  it('BubbleMaps недоступен — fail-closed (штраф + худшая концентрация, не «0% = ок»)', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), {
      available: false,
      topHoldersPercent: 0,
    });
    expect(r.sourcesUnavailable).toContain('BubbleMaps');
    expect(r.holderConcentration).toBe(100);
    expect(r.score).toBeLessThan(100);
  });

  it('высокая концентрация холдеров штрафует скор', () => {
    const r = evaluateSecurity(cleanGmgn(), cleanRug(), { available: true, topHoldersPercent: 80 });
    expect(r.score).toBeLessThan(100);
    expect(r.holderConcentration).toBe(80);
  });

  it('все источники недоступны + нет твиттера — гарантированный провал', () => {
    const r = evaluateSecurity(
      {
        available: false,
        totalFeesSol: 0,
        hasTwitter: false,
        honeypot: false,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      },
      {
        available: false,
        scoreNormalised: null,
        level: 'unknown',
        honeypot: false,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      },
      { available: false, topHoldersPercent: 0 }
    );
    expect(r.passed).toBe(false);
    expect(r.sourcesUnavailable).toEqual(['GMGN', 'RugCheck', 'BubbleMaps']);
  });
});
