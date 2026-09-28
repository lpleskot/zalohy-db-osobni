/* Jeden běh zálohy: výpis všech D1 databází účtu přes Cloudflare API, export každé, která
   ještě nemá dnešní zálohu, uložení do R2 jako <databáze>/<YYYY-MM-DD>.sql.gz, retence
   a stav do _stav.json. Nová databáze na účtu se tak zálohuje sama od první noci. */
import { datumPraha, posunDen, kSmazani } from './retence.js';
import { nahrajProud } from './nahrani.js';

const API = 'https://api.cloudflare.com/client/v4';
export const STAV_KLIC = '_stav.json';
/* Jen soubory záloh — cokoliv jiného ve složce retence nechá být. Nekomprimované .sql jsou
   starší zálohy osobního účtu (dřív je dělal worker todo); retence na ně navazuje. */
const ZALOHA = /^(.+)\/(\d{4}-\d{2}-\d{2})\.sql(\.gz)?$/;

async function cfApi(env, cesta, telo) {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${cesta}`, {
    method: telo === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      ...(telo !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: telo === undefined ? undefined : JSON.stringify(telo),
    /* zaseknuté API nesmí držet běh až do limitu cronu */
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.errors?.[0]?.message ?? `Cloudflare API: HTTP ${res.status}`);
  }
  return data;
}

export async function seznamDatabazi(env) {
  const vse = [];
  for (let strana = 1; ; strana++) {
    const { result, result_info: info } = await cfApi(env, `/d1/database?per_page=100&page=${strana}`);
    vse.push(...result);
    if (!result.length || vse.length >= (info?.total_count ?? vse.length)) return vse;
  }
}

/* Export běží na straně D1 a databáze po tu dobu neodpovídá na dotazy — proto v noci a jedna
   po druhé. Dokud export průběžně nedotazujeme, sám se zruší, takže se čeká tady, ne v dalším
   běhu. Vrací odkaz ke stažení SQL (platí hodinu). */
async function exportuj(env, uuid, { pauzaMs = 1000, maxMs = 10 * 60_000 } = {}) {
  const konec = Date.now() + maxMs;
  let telo = { output_format: 'polling' };
  for (;;) {
    const { result: r } = await cfApi(env, `/d1/database/${uuid}/export`, telo);
    const odkaz = r?.result?.signed_url ?? r?.signed_url;
    if (odkaz) return odkaz;
    if (r?.status === 'error' || r?.error) throw new Error(`Export selhal: ${r.error ?? 'bez popisu'}`);
    if (r?.status === 'complete') throw new Error('Export doběhl bez odkazu ke stažení.');
    if (!r?.at_bookmark) throw new Error('Export: API nevrátilo at_bookmark.');
    if (Date.now() > konec) throw new Error(`Export nedoběhl do ${Math.round(maxMs / 60_000)} min.`);
    telo = { output_format: 'polling', current_bookmark: r.at_bookmark };
    await new Promise((hotovo) => setTimeout(hotovo, pauzaMs));
  }
}

async function zalohujDatabazi(env, db, klic, moznosti) {
  const odkaz = await exportuj(env, db.uuid, moznosti);
  const dump = await fetch(odkaz, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!dump.ok || !dump.body) throw new Error(`Stažení exportu selhalo (HTTP ${dump.status}).`);
  let sql = 0;
  const pocitadlo = new TransformStream({
    transform(kus, ovladac) { sql += kus.byteLength; ovladac.enqueue(kus); },
  });
  const proud = dump.body.pipeThrough(pocitadlo).pipeThrough(new CompressionStream('gzip'));
  const gz = await nahrajProud(env.ZALOHY, klic, proud, { contentType: 'application/gzip' });
  if (!sql) {
    await env.ZALOHY.delete(klic);
    throw new Error('Export je prázdný.');
  }
  return { sql, gz };
}

async function vypisZaloh(env, prefix) {
  const zalohy = [];
  let cursor;
  do {
    const vypis = await env.ZALOHY.list({ prefix, cursor });
    for (const o of vypis.objects) {
      const m = o.key.match(ZALOHA);
      if (m) zalohy.push({ db: m[1], datum: m[2], klic: o.key, velikost: o.size });
    }
    cursor = vypis.truncated ? vypis.cursor : undefined;
  } while (cursor);
  return zalohy;
}

/* Retence jen u databáze, která se právě úspěšně zazálohovala: selhávající databáze ani složka
   smazané databáze tak nepřijdou o žádnou zálohu. */
async function uklid(env, nazev, dnes) {
  const zalohy = (await vypisZaloh(env, `${nazev}/`)).filter((z) => z.db === nazev);
  const smazat = new Set(kSmazani(zalohy.map((z) => z.datum), dnes));
  const klice = zalohy.filter((z) => smazat.has(z.datum)).map((z) => z.klic);
  if (klice.length) await env.ZALOHY.delete(klice);
  return [...smazat].sort();
}

async function ulozStav(env, dnes, databaze, vysledky) {
  const posledni = new Map();
  for (const z of await vypisZaloh(env)) {
    if (!(posledni.get(z.db)?.datum >= z.datum)) posledni.set(z.db, z);
  }
  const stav = {
    cas: new Date().toISOString(),
    datum: dnes,
    databaze: databaze.map((db) => {
      const v = vysledky.find((x) => x.db === db.name);
      const p = posledni.get(db.name);
      return {
        db: db.name,
        posledni: p?.datum ?? null,
        velikostGz: p?.velikost ?? null,
        ...(v && !v.ok && { chyba: v.chyba }),
      };
    }),
  };
  await env.ZALOHY.put(STAV_KLIC, JSON.stringify(stav, null, 2), { httpMetadata: { contentType: 'application/json' } });
  return stav;
}

/* `znovu` přepíše i dnešní zálohy, které už existují (ruční spuštění). Po `limitMs` se další
   export nezačne — cron má limit 15 min a zbytek dorovná další noční pokus. */
export async function zalohujVse(env, { ted = new Date(), znovu = false, pauzaMs, limitMs = 12 * 60_000 } = {}) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new Error('Chybí CF_API_TOKEN (secret) nebo CF_ACCOUNT_ID (var).');
  const zacatek = Date.now();
  const dnes = datumPraha(ted);
  const databaze = await seznamDatabazi(env);
  const vysledky = [];
  for (const db of databaze) {
    const klic = `${db.name}/${dnes}.sql.gz`;
    if (!znovu && (await env.ZALOHY.head(klic))) {
      vysledky.push({ db: db.name, ok: true, uzBylo: true });
      continue;
    }
    if (Date.now() - zacatek > limitMs) {
      vysledky.push({ db: db.name, ok: false, chyba: 'Nestihlo se v tomto běhu, zkusí se v dalším.' });
      continue;
    }
    try {
      const { sql, gz } = await zalohujDatabazi(env, db, klic, { pauzaMs });
      const smazano = await uklid(env, db.name, dnes);
      vysledky.push({ db: db.name, ok: true, klic, sql, gz, smazano });
    } catch (err) {
      vysledky.push({ db: db.name, ok: false, chyba: String(err?.message ?? err) });
    }
  }
  const stav = await ulozStav(env, dnes, databaze, vysledky);
  return { datum: dnes, databazi: databaze.length, vysledky, stav };
}

export async function nactiStav(env) {
  try {
    return (await (await env.ZALOHY.get(STAV_KLIC))?.json()) ?? null;
  } catch {
    return null;
  }
}

/* Stav pro monitoring (status.plegi.cz): v pořádku, když poslední běh není starší než 26 h
   a každá databáze má zálohu nejpozději ze včerejška (pražské datum). */
export function vyhodnotStav(stav, ted = new Date()) {
  if (!stav?.cas) return { ok: false, cronNebezi: true, posledniBeh: null, databazi: 0, problemy: [] };
  const cronNebezi = ted.getTime() - new Date(stav.cas).getTime() > 26 * 3600_000;
  const vcera = posunDen(datumPraha(ted), -1);
  const problemy = (stav.databaze ?? []).filter((d) => !d.posledni || d.posledni < vcera);
  return {
    ok: !cronNebezi && !problemy.length,
    cronNebezi,
    posledniBeh: stav.cas,
    databazi: stav.databaze?.length ?? 0,
    problemy,
  };
}
