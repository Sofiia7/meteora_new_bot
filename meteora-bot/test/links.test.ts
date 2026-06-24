import { describe, it, expect } from 'vitest';
import { tokenLinks, meteoraPoolUrl } from '../src/shared/links';

const CA = 'So11111111111111111111111111111111111111112';
const PAIR = 'PAIRaddr1111111111111111111111111111111111';
const POOL = 'POOLaddr1111111111111111111111111111111111';

describe('tokenLinks', () => {
  it('без пары: 5 ссылок, без Photon, DexScreener падает на CA', () => {
    const links = tokenLinks(CA);
    expect(links.map((l) => l.label)).toEqual([
      'GMGN',
      'Axiom',
      'BubbleMaps',
      'RugCheck',
      'DexScreener',
      'Solscan',
    ]);
    expect(links.find((l) => l.label === 'DexScreener')?.url).toContain(CA);
    expect(links.find((l) => l.label === 'Photon')).toBeUndefined();
  });

  it('с парой: добавляется Photon, DexScreener использует pair', () => {
    const links = tokenLinks(CA, PAIR);
    expect(links.map((l) => l.label)).toContain('Photon');
    expect(links.find((l) => l.label === 'DexScreener')?.url).toContain(PAIR);
    expect(links.find((l) => l.label === 'Photon')?.url).toContain(PAIR);
  });

  it('GMGN / RugCheck / Solscan всегда по mint-адресу', () => {
    const links = tokenLinks(CA, PAIR);
    for (const label of ['GMGN', 'RugCheck', 'Solscan']) {
      expect(links.find((l) => l.label === label)?.url).toContain(CA);
    }
  });
});

describe('meteoraPoolUrl', () => {
  it('строит ссылку на конкретный DLMM-пул', () => {
    expect(meteoraPoolUrl(POOL)).toContain(POOL);
  });
});
