/* Datum a retence záloh. Vše pracuje s pražským datem YYYY-MM-DD, protože tak jsou
   pojmenované soubory a tak je čte člověk v R2. */

const PRAHA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' });

/* Pražské datum okamžiku (en-CA formátuje rovnou jako YYYY-MM-DD). */
export function datumPraha(ted = new Date()) {
  return PRAHA.format(ted);
}

/* Datum posunuté o `dni` (záporně = zpět). */
export function posunDen(datum, dni) {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dni);
  return d.toISOString().slice(0, 10);
}

/* `pocet` uplynulých měsíců před měsícem data `dnes`, od nejbližšího: 2026-09-27 → 2026-08 … 2026-03. */
function uplynuleMesice(dnes, pocet) {
  const [rok, mesic] = dnes.split('-').map(Number);
  return Array.from({ length: pocet }, (_, i) => new Date(Date.UTC(rok, mesic - 2 - i, 1)).toISOString().slice(0, 7));
}

/* Které zálohy jedné databáze smazat. Nechává se:
   - vše z posledních `dni` dní (dnešek a 6 předchozích),
   - vždy `dni` nejnovějších záloh — když zálohování vypadne, poslední dobré zálohy nezmizí,
   - za každý z `mesicu` uplynulých měsíců jeho nejnovější záloha. Normálně je to poslední den
     v měsíci; když se ten den záloha nepovedla, zůstane předchozí a měsíc v řadě nechybí.
   Vstup i výstup jsou data YYYY-MM-DD. */
export function kSmazani(data, dnes, { dni = 7, mesicu = 6 } = {}) {
  const odNejnovejsi = [...new Set(data)].sort().reverse();
  const nechat = new Set(odNejnovejsi.slice(0, dni));
  const hranice = posunDen(dnes, -(dni - 1));
  for (const d of odNejnovejsi) if (d >= hranice) nechat.add(d);
  const mesice = new Set(uplynuleMesice(dnes, mesicu));
  for (const d of odNejnovejsi) {
    const m = d.slice(0, 7);
    if (mesice.delete(m)) nechat.add(d); /* první (nejnovější) záloha daného měsíce */
  }
  return odNejnovejsi.filter((d) => !nechat.has(d));
}
