# zalohy-db-osobni

Centrální noční záloha všech D1 databází **osobního** účtu Cloudflare (lukas.pleskot@chrudim.cz)
do R2. Kopie `plegi-cz/zalohy-db` — liší se jen `wrangler.toml` (účet, bucket `d1-zalohy`)
a tímto README; změny kódu přenášet do obou rep. Worker si každou noc
přes Cloudflare API načte seznam všech databází na účtu a každou vyexportuje do bucketu
`d1-zalohy`. Nová databáze se zálohuje sama od první noci, v projektech se nic nenastavuje.

## Co je v R2

```
d1-zalohy/                         bucket (EEUR)
  _stav.json                       poslední běh a poslední záloha každé databáze
  awam-rezervace-db/
    2026-03-31.sql.gz … 2026-08-31.sql.gz   konec každého ze 6 uplynulých měsíců
    2026-09-21.sql.gz … 2026-09-27.sql.gz   posledních 7 dní
  omega-web-db/
  …
```

- Složka = název databáze, soubor = pražské datum zálohy, obsah = SQL dump (stejný jako
  `wrangler d1 export`) zabalený gzipem.
- **Retence:** posledních 7 dní a za každý ze 6 uplynulých měsíců jeho poslední záloha, obvykle
  z posledního dne v měsíci. Když se záloha poslední den nepovede, zůstane předchozí den.
  7 nejnovějších záloh se nemaže nikdy, takže když zálohování vypadne, poslední dobré zálohy zůstanou.
- Retence běží jen po úspěšné záloze dané databáze. Databáze, jejíž export selhává, ani složka
  **smazané** databáze tak o nic nepřijdou. Složku smazané databáze je potřeba smazat ručně, až
  nebude potřeba.
- Mažou se jen soubory `RRRR-MM-DD.sql.gz`. Cokoliv jiného ve složce retence nechá být.

## Kdy běží a jak se pozná problém

- Cron **0:17, 1:17 a 2:17 UTC** (v Praze 2:17–4:17 v létě, 1:17–3:17 v zimě). První pokus
  zálohuje všechno, další dva jen dorovnají, co chybí.
- Po posledním pokusu přijde **e-mail** na `EMAIL_TO`, když některé databázi dnešní záloha chybí
  nebo když selhal celý běh (např. neplatný token). Když je vše v pořádku, e-mail nechodí.
- `_stav.json` v bucketu a `GET /stav` (pro monitoring, např. status.plegi.cz): `ok`, čas
  posledního běhu a databáze bez zálohy ze dneška nebo včerejška; při problému HTTP 503.
- Logy: dashboard → Workers & Pages → zalohy-db-osobni → Logs.
- Během exportu databáze **neodpovídá na dotazy**, u malých databází jde o vteřiny. Proto se
  zálohuje v noci, jedna databáze po druhé a v minutě :17, mimo crony projektů spouštěné
  každých 5 minut.
- D1 neumí exportovat databázi s virtuální tabulkou (fulltext FTS5).
  Takovou databázi worker pozná (`PRAGMA table_list`) a zazálohuje ji **dotazy přes API**:
  schéma a data po stránkách, stejné SQL jako `sqlite3 .dump`. Fulltext se v záloze založí
  znovu a naplní a obnovuje se stejně jako ostatní zálohy. Rozdíl je, že se tabulky čtou
  postupně, záloha tedy není snímek jednoho okamžiku (v noci to nevadí). Fulltext bez obsahu
  (`content=''`) zálohovat nejde, po obnově ho musí naplnit aplikace.

## Založení (jednou)

1. **Bucket:** `d1-zalohy` už existuje, nic se nezakládá.
2. **API token:** Manage Account → Account API Tokens → Create Token → Custom token. Název
   `zalohy-db`, oprávnění **Account → D1 → Edit**, nic dalšího. Account token nepatří
   konkrétnímu člověku, takže přežije i jeho odchod z účtu.
3. **Worker:** Workers & Pages → Create → Import a repository → `lpleskot/zalohy-db-osobni`. Název
   musí zůstat `zalohy-db-osobni` (sedí s `name` ve `wrangler.toml`). Deploy command
   `npx wrangler deploy`, produkční větev `main`.
4. **Secrets:** Worker zalohy-db-osobni → Settings → Variables and Secrets → Add, typ *Secret*:
   - `CF_API_TOKEN`: token z bodu 2,
   - `RESEND_API_KEY`: klíč z Resend (API Keys, stačí *Sending access*),
   - `SPRAVA_TOKEN`: dlouhý náhodný řetězec (např. `openssl rand -hex 32`), chrání ruční
     spuštění a stav.
5. **Odesílatel e-mailů:** `EMAIL_FROM` je `zalohy@plegi.cz`, doména plegi.cz proto musí být
   v Resend ověřená (Domains). Jinak ve `wrangler.toml` změnit `EMAIL_FROM` na adresu
   z ověřené domény.

## Ověření po nasazení

Adresa workeru je v dashboardu: Worker → Settings → Domains & Routes
(`zalohy-db-osobni.<subdoména>.workers.dev`).

```sh
URL=https://zalohy-db-osobni.<subdoména>.workers.dev
T=<SPRAVA_TOKEN>
curl -X POST -H "Authorization: Bearer $T" $URL/test-email   # přijde zkušební e-mail
curl -X POST -H "Authorization: Bearer $T" $URL/zalohovat    # záloha hned, čeká se na doběhnutí
curl -H "Authorization: Bearer $T" $URL/stav                 # {"ok":true, …}
```

`POST /zalohovat?znovu=1` přepíše i dnešní zálohy. Token jde místo hlavičky poslat i jako
`?token=`, to se hodí pro monitoring. Pak v R2 zkontrolovat složky a `_stav.json`.

## Obnova

Pro posledních 30 dní je nejrychlejší **D1 Time Travel**, který obnoví databázi k libovolné minutě:

```sh
npx wrangler d1 time-travel restore <databaze> --timestamp=2026-09-27T08:00:00+02:00
```

Pro starší stav nebo smazanou databázi se obnovuje ze zálohy v R2, vždy do **nové** databáze:

1. Stáhnout soubor: R2 → d1-zalohy → složka databáze → soubor → Download, nebo
   `npx wrangler r2 object get d1-zalohy/<databaze>/2026-09-27.sql.gz --remote --file zaloha.sql.gz`.
2. Rozbalit: `gunzip zaloha.sql.gz` (na Windows 7-Zip), vznikne `zaloha.sql`.
3. Založit novou databázi a nahrát zálohu:
   ```sh
   npx wrangler d1 create <databaze>-obnova
   npx wrangler d1 execute <databaze>-obnova --remote --file zaloha.sql
   ```
4. Zkontrolovat data. Pak buď přepnout projekt na novou databázi (`database_id` v jeho
   `wrangler.toml`), nebo z ní přenést jen potřebná data.

Obnovu je dobré si občas vyzkoušet do nové databáze, nikdy do produkční.

## Starší zálohy

Dřív zálohy do `d1-zalohy` ukládal worker `todo` jako nekomprimované `.sql`. Retence je počítá
stejně jako nové `.sql.gz` (do posledních 7 dní i měsíčních) a postupně je uklidí.

## Vývoj

```sh
npm install
npm test   # vitest ve workerd s lokálním R2; Cloudflare API, export i Resend jsou podvržené
```

- `src/index.js`: cron (tři pokusy, e-mail po posledním) a správa přes HTTP
- `src/zaloha.js`: výpis databází, export s průběžným dotazováním, uložení, retence, `_stav.json`
- `src/dotazy.js`: záloha dotazy pro databáze s virtuální tabulkou, kterou D1 export neumí
- `src/nahrani.js`: gzip proud do R2 po částech (multipart), bez načtení do paměti
- `src/retence.js`: co smazat, pražské datum
- `src/email.js`: upozornění přes Resend
