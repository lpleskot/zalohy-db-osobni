import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createScheduledController } from 'cloudflare:test';
import worker, { POSLEDNI_POKUS } from '../src/index.js';
import { zalohujVse, STAV_KLIC } from '../src/zaloha.js';
import { posunDen } from '../src/retence.js';
import { VELIKOST_CASTI } from '../src/nahrani.js';

const DNES = new Date('2026-09-27T00:17:00Z');
const db = (name) => ({ uuid: `uuid-${name}`, name, file_size: 1000 });

/* Podvržené Cloudflare API, stažení exportu a Resend. `dumpy` a `chyby` podle názvu databáze.
   Export napoprvé hlásí „běží" a hotový je až při dotazu s bookmarkem (jako skutečné API),
   s `hnedHotovo` hned napoprvé. */
function falesnyUcet({ databaze = [], dumpy = {}, chyby = {}, dotazy = {}, hnedHotovo = false, vypisChyba } = {}) {
  const volani = { exporty: 0, dotazy: 0, emaily: [] };
  const ok = (result, navic = {}, status = 200) => Response.json({ success: true, errors: [], messages: [], result, ...navic }, { status });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (vstup, init = {}) => {
    const url = new URL(typeof vstup === 'string' ? vstup : vstup.url);
    if (url.hostname === 'api.cloudflare.com') {
      expect(init.headers.Authorization).toBe('Bearer test-cf-token');
      const cesta = url.pathname.replace(`/client/v4/accounts/${env.CF_ACCOUNT_ID}`, '');
      if (cesta === '/d1/database') {
        if (vypisChyba) return Response.json({ success: false, errors: [{ code: 10000, message: vypisChyba }] }, { status: 403 });
        return ok(databaze, { result_info: { page: 1, per_page: 100, count: databaze.length, total_count: databaze.length } });
      }
      const dotazNa = cesta.match(/^\/d1\/database\/uuid-(.+)\/query$/)?.[1];
      if (dotazNa) {
        /* Databáze z `dotazy` odpovídá skutečným SQLite (lokální D1), ostatní nemají virtuální tabulku. */
        volani.dotazy++;
        const { sql, params } = JSON.parse(init.body);
        const results = dotazy[dotazNa] ? (await dotazy[dotazNa].prepare(sql).bind(...(params ?? [])).all()).results : [];
        return ok([{ results, success: true, meta: {} }]);
      }
      const nazev = cesta.match(/^\/d1\/database\/uuid-(.+)\/export$/)?.[1];
      if (nazev) {
        volani.exporty++;
        const telo = JSON.parse(init.body);
        expect(telo.output_format).toBe('polling');
        if (chyby[nazev]) return ok({ type: 'export', at_bookmark: 'b1', status: 'error', error: chyby[nazev] });
        if (!telo.current_bookmark && !hnedHotovo) return ok({ type: 'export', at_bookmark: 'b1', status: 'active', messages: [] }, {}, 202);
        if (telo.current_bookmark) expect(telo.current_bookmark).toBe('b1');
        return ok({ type: 'export', at_bookmark: 'b1', status: 'complete', result: { filename: `${nazev}.sql`, signed_url: `https://export.test/${nazev}.sql` } });
      }
    }
    if (url.hostname === 'export.test') return new Response(dumpy[url.pathname.slice(1, -4)]);
    if (url.hostname === 'api.resend.com') {
      volani.emaily.push(JSON.parse(init.body));
      return Response.json({ id: 'email-1' });
    }
    throw new Error(`Neočekávaný fetch: ${url}`);
  });
  return volani;
}

async function klice(prefix) {
  const vse = [];
  let cursor;
  do {
    const vypis = await env.ZALOHY.list({ prefix, cursor });
    vse.push(...vypis.objects.map((o) => o.key));
    cursor = vypis.truncated ? vypis.cursor : undefined;
  } while (cursor);
  return vse.sort();
}

async function rozbal(klic) {
  const o = await env.ZALOHY.get(klic);
  return new Uint8Array(await new Response(o.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
const text = async (klic) => new TextDecoder().decode(await rozbal(klic));

const denne = (od, doDne) => {
  const data = [];
  for (let d = od; d <= doDne; d = posunDen(d, 1)) data.push(d);
  return data;
};

beforeEach(async () => {
  const vse = await klice();
  if (vse.length) await env.ZALOHY.delete(vse);
});
afterEach(() => vi.restoreAllMocks());

describe('záloha všech databází účtu', () => {
  it('uloží každou databázi do <databáze>/<datum>.sql.gz a zapíše _stav.json', async () => {
    const ucet = falesnyUcet({
      databaze: [db('awam-rezervace-db'), db('omega-web-db')],
      dumpy: { 'awam-rezervace-db': 'CREATE TABLE a(x);\nINSERT INTO a VALUES(1);', 'omega-web-db': 'CREATE TABLE b(y);' },
    });
    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });

    expect(beh.vysledky.map((v) => v.ok)).toEqual([true, true]);
    expect(ucet.exporty).toBe(4); /* u každé: spuštění + jeden dotaz s bookmarkem */
    expect(await klice()).toEqual(['_stav.json', 'awam-rezervace-db/2026-09-27.sql.gz', 'omega-web-db/2026-09-27.sql.gz']);
    expect(await text('awam-rezervace-db/2026-09-27.sql.gz')).toBe('CREATE TABLE a(x);\nINSERT INTO a VALUES(1);');
    expect(await text('omega-web-db/2026-09-27.sql.gz')).toBe('CREATE TABLE b(y);');
    expect((await env.ZALOHY.head('omega-web-db/2026-09-27.sql.gz')).httpMetadata.contentType).toBe('application/gzip');

    const stav = await (await env.ZALOHY.get(STAV_KLIC)).json();
    expect(stav.datum).toBe('2026-09-27');
    expect(stav.databaze).toEqual([
      { db: 'awam-rezervace-db', posledni: '2026-09-27', velikostGz: expect.any(Number) },
      { db: 'omega-web-db', posledni: '2026-09-27', velikostGz: expect.any(Number) },
    ]);
  });

  it('další pokus téhož dne už hotové zálohy nepřepisuje, ?znovu ano', async () => {
    const ucet = falesnyUcet({ databaze: [db('a-db')], dumpy: { 'a-db': 'SQL' }, hnedHotovo: true });
    await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    const druhy = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    expect(druhy.vysledky).toEqual([{ db: 'a-db', ok: true, uzBylo: true }]);
    expect(ucet.exporty).toBe(1);
    await zalohujVse(env, { ted: DNES, pauzaMs: 0, znovu: true });
    expect(ucet.exporty).toBe(2);
  });

  it('retence po úspěšné záloze; databáze, jejíž export selže, nepřijde o žádnou zálohu', async () => {
    const stare = denne('2026-02-20', '2026-09-26');
    for (const nazev of ['ok-db', 'rozbita-db']) {
      await Promise.all(stare.map((d) => env.ZALOHY.put(`${nazev}/${d}.sql.gz`, 'x')));
    }
    await env.ZALOHY.put('ok-db/poznamka.txt', 'ručně nahraný soubor retence nemaže');
    falesnyUcet({ databaze: [db('ok-db'), db('rozbita-db')], dumpy: { 'ok-db': 'SQL' }, chyby: { 'rozbita-db': 'Database is locked' } });

    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });

    expect(beh.vysledky[1]).toEqual({ db: 'rozbita-db', ok: false, chyba: 'Export selhal: Database is locked' });
    expect(await klice('ok-db/')).toEqual([
      ...['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31'].map((d) => `ok-db/${d}.sql.gz`),
      ...denne('2026-09-21', '2026-09-27').map((d) => `ok-db/${d}.sql.gz`),
      'ok-db/poznamka.txt',
    ]);
    expect(await klice('rozbita-db/')).toHaveLength(stare.length);
    const stav = await (await env.ZALOHY.get(STAV_KLIC)).json();
    expect(stav.databaze[1]).toMatchObject({ db: 'rozbita-db', posledni: '2026-09-26', chyba: 'Export selhal: Database is locked' });
  });

  it('navazuje na starší nekomprimované .sql (osobní účet) a retencí je postupně uklidí', async () => {
    const stare = denne('2026-08-20', '2026-09-26');
    await Promise.all(stare.map((d) => env.ZALOHY.put(`todo-db/${d}.sql`, 'SQL')));
    falesnyUcet({ databaze: [db('todo-db')], dumpy: { 'todo-db': 'SQL' } });
    await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    expect(await klice('todo-db/')).toEqual([
      'todo-db/2026-08-31.sql',
      ...denne('2026-09-21', '2026-09-26').map((d) => `todo-db/${d}.sql`),
      'todo-db/2026-09-27.sql.gz',
    ]);
  });

  it('složka smazané databáze zůstane beze změny', async () => {
    const stare = denne('2026-01-01', '2026-09-20');
    await Promise.all(stare.map((d) => env.ZALOHY.put(`smazana-db/${d}.sql.gz`, 'x')));
    falesnyUcet({ databaze: [db('a-db')], dumpy: { 'a-db': 'SQL' } });
    await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    expect(await klice('smazana-db/')).toHaveLength(stare.length);
  });

  it('velký export jde do R2 po částech a rozbalí se na původní obsah', async () => {
    /* ~20 MB „SQL" z 16 náhodných písmen: gzip ho zmenší jen na polovinu → víc než jedna část */
    const velky = new Uint8Array(20 * 1024 * 1024);
    for (let i = 0; i < velky.length; i += 65536) crypto.getRandomValues(velky.subarray(i, i + 65536));
    for (let i = 0; i < velky.length; i++) velky[i] = 97 + (velky[i] & 15);
    falesnyUcet({ databaze: [db('velka-db')], dumpy: { 'velka-db': velky } });

    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });

    expect(beh.vysledky[0]).toMatchObject({ ok: true, sql: velky.length });
    expect(beh.vysledky[0].gz).toBeGreaterThan(VELIKOST_CASTI);
    const zpet = await rozbal('velka-db/2026-09-27.sql.gz');
    const hash = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].join(',');
    expect(await hash(zpet)).toBe(await hash(velky));
  });

  it('prázdný export je chyba a nezůstane po něm soubor', async () => {
    falesnyUcet({ databaze: [db('prazdna-db')], dumpy: { 'prazdna-db': '' } });
    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    expect(beh.vysledky[0]).toEqual({ db: 'prazdna-db', ok: false, chyba: 'Export je prázdný.' });
    expect(await env.ZALOHY.head('prazdna-db/2026-09-27.sql.gz')).toBeNull();
  });
});

/* Rozdělí SQL zálohy na příkazy jako `wrangler d1 execute --file`: středník mimo řetězce
   a komentáře, u triggeru až za END (lokální D1 exec() dělí jen po řádcích). */
function prikazy(sql) {
  const vysledek = [];
  let zacatek = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      for (i++; i < sql.length && !(sql[i] === c && sql[i + 1] !== c); i += sql[i] === c ? 2 : 1);
    } else if (c === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === ';') {
      const prikaz = sql.slice(zacatek, i).trim();
      const bezKomentaru = prikaz.replace(/^(--[^\n]*\n\s*)+/, '');
      if (/^CREATE\s+TRIGGER\b/i.test(bezKomentaru) && !/\bEND$/i.test(prikaz)) continue;
      if (bezKomentaru) vysledek.push(prikaz);
      zacatek = i + 1;
    }
  }
  return vysledek;
}

/* Databáze jako jezerka-db: fulltext s vlastním obsahem, fulltext nad tabulkou (externí obsah)
   s triggerem, fulltext bez obsahu, AUTOINCREMENT, WITHOUT ROWID, generovaný sloupec, index,
   pohled a hodnoty, které se přes JSON snadno pokazí (velké celé číslo, desetinné, blob). */
const SCHEMA = [
  `CREATE TABLE autori (id INTEGER PRIMARY KEY AUTOINCREMENT, jmeno TEXT NOT NULL, cislo INTEGER, kurz REAL, data BLOB, poznamka TEXT)`,
  `CREATE TABLE stitky (kod TEXT PRIMARY KEY, nazev TEXT) WITHOUT ROWID`,
  `CREATE TABLE clanky (id INTEGER PRIMARY KEY, autor_id INTEGER REFERENCES autori (id), titulek TEXT, text TEXT,
     delka INTEGER GENERATED ALWAYS AS (length(text)) VIRTUAL)`,
  `CREATE TABLE "objednávky-2026" ("select" TEXT, "a""b" INTEGER)`,
  `CREATE INDEX clanky_autor ON clanky (autor_id)`,
  `CREATE VIRTUAL TABLE hledani USING fts5(titulek, text, zdroj UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE VIRTUAL TABLE clanky_fts USING fts5(titulek, text, content='clanky', content_rowid='id')`,
  `CREATE VIRTUAL TABLE bez_obsahu USING fts5(t, content='')`,
  `CREATE TRIGGER clanky_ai AFTER INSERT ON clanky BEGIN
     INSERT INTO clanky_fts (rowid, titulek, text) VALUES (new.id, new.titulek, new.text);
   END`,
  `CREATE VIEW clanky_autoru AS SELECT a.jmeno, c.titulek FROM clanky c JOIN autori a ON a.id = c.autor_id`,
];

async function naplnZdroj() {
  const d = env.ZDROJ;
  await d.batch(SCHEMA.map((q) => d.prepare(q)));
  await d.batch([
    d.prepare(`INSERT INTO autori (jmeno, cislo, kurz, data, poznamka) VALUES ('Jiří Novák', 9007199254740993, 0.1 + 0.2, X'00FF10', 'O''Brien; řádek
nový')`),
    d.prepare(`INSERT INTO autori (jmeno) VALUES ('Anna')`),
    d.prepare(`INSERT INTO autori (jmeno) VALUES ('smazaný')`),
    d.prepare(`DELETE FROM autori WHERE jmeno = 'smazaný'`),
    d.prepare(`INSERT INTO stitky VALUES ('b', 'Béčko'), ('a', 'Áčko')`),
    d.prepare(`INSERT INTO clanky (id, autor_id, titulek, text) VALUES (1, 1, 'Žlutý kůň', 'úpěl ďábelské ódy'), (2, 2, 'Jezero', 'koupání; "uvozovky"')`),
    d.prepare(`INSERT INTO "objednávky-2026" VALUES ('drop table', 7)`),
    d.prepare(`INSERT INTO bez_obsahu (t) VALUES ('nic se nezálohuje')`),
  ]);
  /* 250 řádků fulltextu: víc stránek čtení */
  const radky = Array.from({ length: 250 }, (_, i) => d.prepare(`INSERT INTO hledani (rowid, titulek, text, zdroj) VALUES (?, ?, ?, ?)`)
    .bind(i * 3 + 1, `Stránka ${i}`, i % 50 === 0 ? 'žlutý kůň na jezeře' : `obsah ${i}`, `page:${i}:cs`));
  await d.batch(radky);
}

const vsechno = async (d, sql) => (await d.prepare(sql).all()).results;

describe('databáze s fulltextem (FTS5), kterou D1 export neumí', () => {
  it('zazálohuje se dotazy a ze zálohy jde obnovit včetně fulltextu', async () => {
    await naplnZdroj();
    const ucet = falesnyUcet({
      databaze: [db('jezerka-db')],
      dotazy: { 'jezerka-db': env.ZDROJ },
      chyby: { 'jezerka-db': 'D1 Export error: cannot export databases with virtual tables (like FTS5)' },
    });

    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });

    expect(beh.vysledky[0]).toMatchObject({ db: 'jezerka-db', ok: true, dotazy: true });
    expect(ucet.exporty).toBe(0);
    const sql = await text('jezerka-db/2026-09-27.sql.gz');
    expect(sql).not.toMatch(/_cf_|hledani_data|hledani_idx|hledani_content|clanky_fts_data/);

    await env.CIL.batch(prikazy(sql).map((q) => env.CIL.prepare(q)));

    const autori = `SELECT id, jmeno, quote(cislo) AS cislo, quote(kurz) AS kurz, hex(data) AS data, poznamka FROM autori ORDER BY id`;
    expect(await vsechno(env.CIL, autori)).toEqual(await vsechno(env.ZDROJ, autori));
    expect((await vsechno(env.CIL, autori))[0]).toMatchObject({ cislo: '9007199254740993', data: '00FF10', poznamka: "O'Brien; řádek\nnový" });
    for (const dotaz of [
      'SELECT * FROM stitky',
      'SELECT id, autor_id, titulek, text, delka FROM clanky ORDER BY id',
      'SELECT * FROM "objednávky-2026"',
      'SELECT * FROM clanky_autoru ORDER BY titulek',
      'SELECT name, seq FROM sqlite_sequence',
    ]) {
      expect(await vsechno(env.CIL, dotaz)).toEqual(await vsechno(env.ZDROJ, dotaz));
    }

    /* fulltext s vlastním obsahem: všechny řádky i s rowid a funkční hledání bez diakritiky */
    expect(await vsechno(env.CIL, 'SELECT count(*) AS n FROM hledani')).toEqual([{ n: 250 }]);
    const najdi = `SELECT rowid, titulek, zdroj FROM hledani WHERE hledani MATCH 'zluty' ORDER BY rowid`;
    expect(await vsechno(env.CIL, najdi)).toEqual(await vsechno(env.ZDROJ, najdi));
    expect(await vsechno(env.CIL, najdi)).toHaveLength(5);
    /* fulltext nad tabulkou: index přestavěný ('rebuild') a trigger obnovený až po datech */
    const vClancich = `SELECT rowid FROM clanky_fts WHERE clanky_fts MATCH 'upel' ORDER BY rowid`;
    expect(await vsechno(env.CIL, vClancich)).toEqual([{ rowid: 1 }]);
    await env.CIL.prepare(`INSERT INTO clanky (id, autor_id, titulek, text) VALUES (3, 1, 'Nový', 'úpěl znovu')`).run();
    expect(await vsechno(env.CIL, vClancich)).toEqual([{ rowid: 1 }, { rowid: 3 }]);
    /* AUTOINCREMENT pokračuje za smazaným id 3 */
    expect((await env.CIL.prepare(`INSERT INTO autori (jmeno) VALUES ('Nový') RETURNING id`).first()).id).toBe(4);
    /* fulltext bez obsahu se založí prázdný, naplnit ho musí aplikace */
    expect(sql).toContain("-- bez_obsahu: fulltext bez obsahu (content='')");
    expect(await vsechno(env.CIL, 'SELECT count(*) AS n FROM bez_obsahu')).toEqual([{ n: 0 }]);
    expect((await vsechno(env.CIL, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'clanky_autor'`))).toHaveLength(1);
  });

  it('databáze bez virtuální tabulky dál jde exportem', async () => {
    const ucet = falesnyUcet({ databaze: [db('a-db')], dumpy: { 'a-db': 'SQL' } });
    const beh = await zalohujVse(env, { ted: DNES, pauzaMs: 0 });
    expect(beh.vysledky[0]).toEqual(expect.not.objectContaining({ dotazy: true }));
    expect(ucet.dotazy).toBe(1); /* jen PRAGMA table_list */
    expect(ucet.exporty).toBe(2);
  });
});

describe('noční cron a upozornění', () => {
  const cron = (vyraz, iso) => createScheduledController({ cron: vyraz, scheduledTime: Date.parse(iso) });

  it('e-mail až po posledním pokusu a jen s databázemi, které zálohu pořád nemají', async () => {
    const ucet = falesnyUcet({
      databaze: [db('ok-db'), db('rozbita-db')],
      dumpy: { 'ok-db': 'SQL' },
      chyby: { 'rozbita-db': 'Database is locked' },
      hnedHotovo: true,
    });
    await worker.scheduled(cron('17 0 * * *', '2026-09-27T00:17:00Z'), env);
    await worker.scheduled(cron('17 1 * * *', '2026-09-27T01:17:00Z'), env);
    expect(ucet.emaily).toHaveLength(0);
    expect(ucet.exporty).toBe(3); /* ok-db jen napoprvé, rozbitá při každém pokusu */

    await worker.scheduled(cron(POSLEDNI_POKUS, '2026-09-27T02:17:00Z'), env);
    expect(ucet.emaily).toHaveLength(1);
    const [email] = ucet.emaily;
    expect(email.to).toEqual(['pleskot@plegi.cz']);
    expect(email.from).toBe('Zálohy DB <zalohy@plegi.cz>');
    expect(email.subject).toBe('Záloha DB 2026-09-27: 1 z 2 databází bez zálohy');
    expect(email.text).toContain('- rozbita-db: Export selhal: Database is locked');
    expect(email.text).not.toContain('ok-db');
  });

  it('když vše projde, e-mail nechodí', async () => {
    const ucet = falesnyUcet({ databaze: [db('ok-db')], dumpy: { 'ok-db': 'SQL' }, hnedHotovo: true });
    await worker.scheduled(cron(POSLEDNI_POKUS, '2026-09-27T02:17:00Z'), env);
    expect(ucet.emaily).toHaveLength(0);
  });

  it('když selže celý běh (např. neplatný token), poslední pokus pošle e-mail a skončí chybou', async () => {
    const ucet = falesnyUcet({ vypisChyba: 'Authentication error' });
    await expect(worker.scheduled(cron('17 0 * * *', '2026-09-27T00:17:00Z'), env)).rejects.toThrow('Authentication error');
    expect(ucet.emaily).toHaveLength(0);
    await expect(worker.scheduled(cron(POSLEDNI_POKUS, '2026-09-27T02:17:00Z'), env)).rejects.toThrow('Authentication error');
    expect(ucet.emaily).toHaveLength(1);
    expect(ucet.emaily[0].subject).toBe('Záloha DB neproběhla');
    expect(ucet.emaily[0].text).toContain('Authentication error');
  });
});

describe('správa přes HTTP', () => {
  const zavolej = async (cesta, { method = 'GET', token, prostredi = env } = {}) => {
    const res = await worker.fetch(new Request(`https://zalohy-db.test${cesta}`, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {},
    }), prostredi);
    return { status: res.status, telo: await res.json() };
  };

  it('bez SPRAVA_TOKEN je vypnutá, bez tokenu nebo se špatným 401', async () => {
    /* defineProperty, ne přiřazení — env je proxy a přiřazení přes prototyp by token smazalo i v něm */
    const bezTokenu = Object.create(env, { SPRAVA_TOKEN: { value: undefined } });
    expect((await zavolej('/stav', { prostredi: bezTokenu, token: 'test-sprava' })).status).toBe(404);
    expect((await zavolej('/stav')).status).toBe(401);
    expect((await zavolej('/stav', { token: 'spatny-token' })).status).toBe(401);
    expect((await zavolej('/neexistuje', { token: 'test-sprava' })).status).toBe(404);
  });

  it('POST /zalohovat spustí zálohu, GET /stav ji vyhodnotí (i s ?token=)', async () => {
    falesnyUcet({ databaze: [db('a-db')], dumpy: { 'a-db': 'SQL' }, hnedHotovo: true });
    let r = await zavolej('/stav', { token: 'test-sprava' });
    expect(r.status).toBe(503);
    expect(r.telo.cronNebezi).toBe(true);

    r = await zavolej('/zalohovat', { method: 'POST', token: 'test-sprava' });
    expect(r.status).toBe(200);
    expect(r.telo.vysledky[0]).toMatchObject({ db: 'a-db', ok: true });

    r = await zavolej('/stav?token=test-sprava');
    expect(r.status).toBe(200);
    expect(r.telo).toMatchObject({ ok: true, databazi: 1, problemy: [] });
  });

  it('POST /test-email pošle zkušební e-mail', async () => {
    const ucet = falesnyUcet();
    const r = await zavolej('/test-email', { method: 'POST', token: 'test-sprava' });
    expect(r).toEqual({ status: 200, telo: { ok: true } });
    expect(ucet.emaily[0].subject).toBe('Záloha DB: testovací e-mail');
  });
});
