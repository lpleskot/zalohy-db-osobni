import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/* Testy běží ve workerd s lokálním R2 (Miniflare). Cloudflare API, stažení exportu i Resend
   se v testech podvrhují přes fetch — nic se nedotkne skutečného účtu. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { CF_API_TOKEN: 'test-cf-token', RESEND_API_KEY: 'test-resend', SPRAVA_TOKEN: 'test-sprava' } },
    }),
  ],
});
