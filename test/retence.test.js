import { describe, it, expect } from 'vitest';
import { kSmazani, datumPraha, posunDen } from '../src/retence.js';
import { vyhodnotStav } from '../src/zaloha.js';

/* Denní zálohy od `od` do `doDne` včetně. */
const denne = (od, doDne) => {
  const data = [];
  for (let d = od; d <= doDne; d = posunDen(d, 1)) data.push(d);
  return data;
};
const zbyde = (data, dnes) => {
  const smazat = new Set(kSmazani(data, dnes));
  return data.filter((d) => !smazat.has(d)).sort();
};

describe('retence', () => {
  it('nechá posledních 7 dní a konec každého ze 6 uplynulých měsíců', () => {
    expect(zbyde(denne('2026-01-01', '2026-09-27'), '2026-09-27')).toEqual([
      '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
    ]);
  });

  it('prvního v měsíci je konec minulého měsíce mezi denními i měsíčními, nejstarší měsíc odpadne', () => {
    expect(zbyde(denne('2026-01-01', '2026-10-01'), '2026-10-01')).toEqual([
      '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
      '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
    ]);
  });

  it('když chybí záloha z posledního dne měsíce, zůstane předchozí den', () => {
    const data = denne('2026-01-01', '2026-09-27').filter((d) => d !== '2026-08-31');
    const zbylo = zbyde(data, '2026-09-27');
    expect(zbylo).toContain('2026-08-30');
    expect(zbylo.filter((d) => d.startsWith('2026-08'))).toEqual(['2026-08-30']);
  });

  it('když zálohování vypadne, posledních 7 záloh se nesmaže', () => {
    const data = denne('2026-01-01', '2026-09-10');
    expect(zbyde(data, '2026-09-27')).toEqual([
      '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
      '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
    ]);
  });

  it('přes přelom roku', () => {
    expect(zbyde(denne('2026-05-01', '2027-01-05'), '2027-01-05')).toEqual([
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30',
      '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05',
    ]);
  });

  it('nová databáze s pár zálohami nepřijde o nic', () => {
    expect(kSmazani(['2026-09-25', '2026-09-26', '2026-09-27'], '2026-09-27')).toEqual([]);
  });
});

describe('pražské datum', () => {
  it('půlnoc podle Prahy, léto i zima', () => {
    expect(datumPraha(new Date('2026-09-27T22:30:00Z'))).toBe('2026-09-28'); /* 0:30 CEST */
    expect(datumPraha(new Date('2026-09-27T21:59:59Z'))).toBe('2026-09-27');
    expect(datumPraha(new Date('2026-01-10T23:30:00Z'))).toBe('2026-01-11'); /* 0:30 CET */
    expect(datumPraha(new Date('2026-01-10T22:59:59Z'))).toBe('2026-01-10');
  });
  it('noční crony (0:17–2:17 UTC) patří do stejného dne jako v Praze', () => {
    expect(datumPraha(new Date('2026-09-27T00:17:00Z'))).toBe('2026-09-27');
    expect(datumPraha(new Date('2026-01-10T02:17:00Z'))).toBe('2026-01-10');
  });
});

describe('vyhodnocení stavu pro monitoring', () => {
  const ted = new Date('2026-09-27T10:00:00Z');
  it('bez _stav.json cron neběží', () => {
    expect(vyhodnotStav(null, ted)).toMatchObject({ ok: false, cronNebezi: true });
  });
  it('v pořádku, když má každá databáze zálohu nejpozději ze včerejška', () => {
    const stav = { cas: '2026-09-27T00:16:00Z', databaze: [{ db: 'a', posledni: '2026-09-27' }, { db: 'b', posledni: '2026-09-26' }] };
    expect(vyhodnotStav(stav, ted)).toMatchObject({ ok: true, cronNebezi: false, databazi: 2, problemy: [] });
  });
  it('databáze bez zálohy nebo se starou zálohou je problém', () => {
    const stav = { cas: '2026-09-27T00:16:00Z', databaze: [{ db: 'a', posledni: '2026-09-25' }, { db: 'b', posledni: null }, { db: 'c', posledni: '2026-09-27' }] };
    const v = vyhodnotStav(stav, ted);
    expect(v.ok).toBe(false);
    expect(v.problemy.map((p) => p.db)).toEqual(['a', 'b']);
  });
  it('běh starší než 26 h znamená, že cron neběží', () => {
    const stav = { cas: '2026-09-26T07:00:00Z', databaze: [{ db: 'a', posledni: '2026-09-26' }] };
    expect(vyhodnotStav(stav, ted)).toMatchObject({ ok: false, cronNebezi: true });
  });
});
