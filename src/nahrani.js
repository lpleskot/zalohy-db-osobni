/* Nahrání proudu neznámé délky do R2 bez načtení celého souboru do paměti (limit Workeru 128 MB,
   největší databáze účtu má přes 160 MB). R2 u streamu vyžaduje známou délku, proto po částech:
   multipart upload, kde všechny části kromě poslední musí mít stejnou velikost (min. 5 MiB).
   Menší soubor než jedna část jde obyčejným put(). Vrací počet nahraných bajtů. */

export const VELIKOST_CASTI = 8 * 1024 * 1024;

export async function nahrajProud(bucket, klic, proud, httpMetadata, velikostCasti = VELIKOST_CASTI) {
  const ctenar = proud.getReader();
  let upload = null;
  const casti = [];
  let buf = new Uint8Array(velikostCasti);
  let plno = 0;
  let celkem = 0;
  try {
    for (;;) {
      const { done, value } = await ctenar.read();
      if (done) break;
      for (let od = 0; od < value.byteLength;) {
        const n = Math.min(value.byteLength - od, velikostCasti - plno);
        buf.set(value.subarray(od, od + n), plno);
        plno += n;
        od += n;
        if (plno === velikostCasti) {
          upload ??= await bucket.createMultipartUpload(klic, { httpMetadata });
          casti.push(await upload.uploadPart(casti.length + 1, buf));
          celkem += plno;
          buf = new Uint8Array(velikostCasti);
          plno = 0;
        }
      }
    }
    celkem += plno;
    if (!upload) {
      await bucket.put(klic, buf.subarray(0, plno), { httpMetadata });
      return celkem;
    }
    if (plno) casti.push(await upload.uploadPart(casti.length + 1, buf.subarray(0, plno)));
    await upload.complete(casti);
    return celkem;
  } catch (err) {
    /* Nedokončený upload by jinak visel 7 dní; soubor se v R2 objeví až po complete(). */
    await upload?.abort().catch(() => {});
    await ctenar.cancel(err).catch(() => {});
    throw err;
  }
}
