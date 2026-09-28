/* Upozornění e-mailem přes Resend. Selhání e-mailu zálohu neshodí, jen se zapíše do logu. */

export async function posliEmail(env, predmet, text) {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) {
    console.error('E-mail se neposlal (chybí RESEND_API_KEY, EMAIL_TO nebo EMAIL_FROM):', predmet);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: env.EMAIL_TO.split(',').map((a) => a.trim()).filter(Boolean),
        subject: predmet,
        text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    console.error(`Resend odmítl e-mail (HTTP ${res.status}):`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error('Resend nedostupný:', err);
  }
  return false;
}

/* [předmět, text] e-mailu po posledním nočním pokusu, když některé databázi záloha chybí. */
export function upozorneni(beh) {
  const chyby = beh.vysledky.filter((v) => !v.ok);
  return [
    `Záloha DB ${beh.datum}: ${chyby.length} z ${beh.databazi} databází bez zálohy`,
    [
      `Noční záloha D1 ${beh.datum} ani po posledním pokusu nezazálohovala:`,
      '',
      ...chyby.map((v) => `- ${v.db}: ${v.chyba}`),
      '',
      'Ostatní databáze jsou zazálohované. Přehled je v souboru _stav.json v bucketu záloh.',
      'Znovu spustit lze ručně: POST /zalohovat na workeru zalohy-db (postup v README repozitáře).',
    ].join('\n'),
  ];
}
