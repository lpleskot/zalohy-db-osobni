/* Záloha databáze, kterou D1 export neumí: databáze s virtuální tabulkou (fulltext FTS5).
   Čte se dotazy přes API a skládá se stejné SQL jako u sqlite3 .dump: schéma ze sqlite_master,
   data tabulek po stránkách, hodnoty přes quote() (texty, čísla i bloby přesně, bez převodu
   přes JSON). Virtuální tabulka se v záloze založí znovu (stínové tabulky …_data, …_idx si
   SQLite při obnově vytvoří samo) a naplní: FTS5 s vlastním obsahem řádky, s externím obsahem
   příkazem 'rebuild'. Fulltext bez obsahu (content='') naplnit nejde, to musí po obnově udělat
   aplikace. Indexy, triggery a pohledy jdou až za data, aby triggery při obnově nezapisovaly
   podruhé. Na rozdíl od exportu to není snímek jednoho okamžiku, tabulky se čtou postupně. */

const ident = (nazev) => `"${String(nazev).replaceAll('"', '""')}"`;
const INTERNI = /^(sqlite_|_cf_)/;
/* Cílová velikost jedné stránky dat — počet řádků se podle ní upravuje, aby se do paměti
   Workeru vešly i tabulky s dlouhými texty. */
const STRANKA_ZNAKU = 4_000_000;

async function* radky(dotaz, nazev, { bezRowid, sRowid }) {
  const sloupce = (await dotaz(`PRAGMA table_info(${ident(nazev)})`)).map((s) => s.name);
  const hodnoty = sloupce.map((s) => `quote(${ident(s)})`).join(`||','||`);
  const zacatek = `INSERT INTO ${ident(nazev)}(${sRowid ? 'rowid,' : ''}${sloupce.map(ident).join(',')}) VALUES(`;
  let limit = 100;
  let offset = 0;
  let posledni = null;
  for (;;) {
    const strana = bezRowid
      ? await dotaz(`SELECT ${hodnoty} AS v FROM ${ident(nazev)} LIMIT ${limit} OFFSET ${offset}`)
      : await dotaz(
          `SELECT CAST(rowid AS TEXT) AS r, ${hodnoty} AS v FROM ${ident(nazev)}` +
            `${posledni === null ? '' : ' WHERE rowid > CAST(? AS INTEGER)'} ORDER BY rowid LIMIT ${limit}`,
          posledni === null ? [] : [posledni],
        );
    let znaku = 0;
    for (const r of strana) {
      znaku += r.v.length;
      yield `${zacatek}${sRowid ? `${r.r},` : ''}${r.v});\n`;
    }
    if (strana.length < limit) return;
    offset += strana.length;
    posledni = strana.at(-1).r;
    limit = Math.max(1, Math.min(1000, Math.floor((limit * STRANKA_ZNAKU) / Math.max(znaku, 1))));
  }
}

/* `dotaz(sql, params)` vrací řádky jako objekty; `seznam` je výsledek PRAGMA table_list. */
export async function* sqlDotazy(dotaz, seznam) {
  const druh = new Map(seznam.filter((t) => t.schema === 'main').map((t) => [t.name, t]));
  const vynechat = (nazev) => INTERNI.test(nazev) || druh.get(nazev)?.type === 'shadow';
  const schema = await dotaz('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid');
  const tabulky = schema.filter((o) => o.type === 'table' && !vynechat(o.name));
  const jeVirtualni = (o) => druh.get(o.name)?.type === 'virtual';

  yield '-- Záloha dotazy: databáze má virtuální tabulku (fulltext), kterou D1 export neumí.\n';
  yield 'PRAGMA defer_foreign_keys=TRUE;\n';
  for (const t of tabulky.filter((o) => !jeVirtualni(o))) {
    yield `${t.sql};\n`;
    yield* radky(dotaz, t.name, { bezRowid: druh.get(t.name)?.wr === 1, sRowid: false });
  }
  if (druh.has('sqlite_sequence')) {
    const citace = await dotaz('SELECT quote(name) AS n, quote(seq) AS s FROM sqlite_sequence');
    if (citace.length) yield 'DELETE FROM sqlite_sequence;\n';
    for (const c of citace) yield `INSERT INTO sqlite_sequence VALUES(${c.n},${c.s});\n`;
  }
  for (const t of tabulky.filter(jeVirtualni)) {
    yield `${t.sql};\n`;
    const obsah = t.sql.match(/\bcontent\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s,)]+))/i);
    const externi = obsah ? (obsah[1] ?? obsah[2] ?? obsah[3]) : null;
    if (externi === '') yield `-- ${t.name}: fulltext bez obsahu (content=''), po obnově ho musí naplnit aplikace.\n`;
    else if (externi) yield `INSERT INTO ${ident(t.name)}(${ident(t.name)}) VALUES('rebuild');\n`;
    else yield* radky(dotaz, t.name, { bezRowid: false, sRowid: true });
  }
  for (const o of schema) {
    if (o.type !== 'table' && !vynechat(o.tbl_name)) yield `${o.sql};\n`;
  }
}

/* Proud bajtů z asynchronního generátoru textu; další kus se načte, až o něj čtenář požádá. */
export function proudZTextu(texty) {
  const kodovani = new TextEncoder();
  return new ReadableStream({
    async pull(ovladac) {
      const { value, done } = await texty.next();
      if (done) ovladac.close();
      else ovladac.enqueue(kodovani.encode(value));
    },
    async cancel(duvod) {
      await texty.return?.(duvod);
    },
  });
}
