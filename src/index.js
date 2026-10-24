import { zalohujVse, nactiStav, vyhodnotStav } from './zaloha.js';
import { posliEmail, upozorneni } from './email.js';

/* Poslední noční pokus — po něm e-mail, když některé databázi dnešní záloha chybí.
   Musí sedět s posledním cronem ve wrangler.toml. */
export const POSLEDNI_POKUS = '17 2 * * *';

const json = (data, status = 200) => Response.json(data, { status });

/* Bez tokenu se nic nezálohuje a bez Resend nepřijde ani e-mail o chybě. /stav to musí ukázat,
   jinak záloha nefunguje potichu (osobní účet bez CF_API_TOKEN, září–říjen 2026). */
const POTREBNE_SECRETS = ['CF_API_TOKEN', 'RESEND_API_KEY'];

function platnyToken(zadany, spravny) {
  if (!zadany || !spravny) return false;
  const a = new TextEncoder().encode(zadany);
  const b = new TextEncoder().encode(spravny);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async scheduled(controller, env) {
    const posledni = controller.cron === POSLEDNI_POKUS;
    let beh;
    try {
      beh = await zalohujVse(env, { ted: new Date(controller.scheduledTime) });
    } catch (err) {
      console.error('Záloha D1: běh selhal:', err);
      if (posledni) {
        await posliEmail(env, 'Záloha DB neproběhla', `Noční záloha D1 selhala celá: ${err?.message ?? err}`);
      }
      throw err; /* v dashboardu se pak běh ukáže jako chybový */
    }
    const chyby = beh.vysledky.filter((v) => !v.ok);
    if (chyby.length) console.error('Záloha D1: bez zálohy zůstalo', JSON.stringify(chyby));
    if (posledni && chyby.length) await posliEmail(env, ...upozorneni(beh));
  },

  /* Správa přes workers.dev, vše jen s SPRAVA_TOKEN (Bearer nebo ?token=):
       GET  /stav        — vyhodnocený stav záloh (503, když je problém) — pro monitoring
       POST /zalohovat   — spustí zálohu hned (?znovu=1 přepíše i dnešní zálohy)
       POST /test-email  — ověří, že upozornění dorazí */
  async fetch(request, env) {
    if (!env.SPRAVA_TOKEN) return json({ error: 'Nenalezeno.' }, 404);
    const url = new URL(request.url);
    const zadany = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
    if (!platnyToken(zadany, env.SPRAVA_TOKEN)) return json({ error: 'Neplatný token.' }, 401);

    const cesta = `${request.method} ${url.pathname}`;
    if (cesta === 'GET /stav') {
      const stav = vyhodnotStav(await nactiStav(env));
      const chybi = POTREBNE_SECRETS.filter((nazev) => !env[nazev]);
      if (chybi.length) Object.assign(stav, { ok: false, chybiNastaveni: chybi });
      return json(stav, stav.ok ? 200 : 503);
    }
    if (cesta === 'POST /zalohovat') {
      try {
        return json(await zalohujVse(env, { znovu: url.searchParams.get('znovu') === '1' }));
      } catch (err) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }
    if (cesta === 'POST /test-email') {
      const ok = await posliEmail(env, 'Záloha DB: testovací e-mail', 'Upozornění na selhání noční zálohy D1 budou chodit sem.');
      return json({ ok }, ok ? 200 : 502);
    }
    return json({ error: 'Nenalezeno.' }, 404);
  },
};
