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
function falesnyUcet({ databaze = [], dumpy = {}, chyby = {}, hnedHotovo = false, vypisChyba } = {}) {
  const volani = { exporty: 0, emaily: [] };
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
