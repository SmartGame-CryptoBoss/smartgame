# SmartGame leads Worker

The Worker is the only public path from the SmartGame form to Google Forms. It validates the request origin and payload, checks a signed time challenge, applies per-IP rate limits, and suppresses identical leads with Workers KV.

## Limits

- minimum form time: 3 seconds;
- challenge lifetime: 2 hours;
- request body: 16 KiB;
- attempts per IP: 8 per minute;
- accepted valid leads per IP: 2 per minute;
- identical-lead suppression: 10 minutes.

## Deploy

1. Run `pnpm install` and `pnpm test`.
2. Set a random secret of at least 32 characters with `pnpm wrangler secret put CHALLENGE_SECRET`.
3. Run `pnpm deploy`. Wrangler provisions the `DEDUPE` KV namespace and writes its ID back to `wrangler.jsonc` on first deploy.

Never commit `CHALLENGE_SECRET` or a local `.dev.vars` file.
