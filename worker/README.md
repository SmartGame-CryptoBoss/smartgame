# SmartGame leads Worker

The Worker is the only public path from the SmartGame form to Google Forms and Telegram. It validates the request origin and payload, checks a signed time challenge, applies per-IP rate limits, and suppresses identical leads with Workers KV. Telegram delivery runs only after all anti-spam checks and a successful Google Forms delivery, so the existing lead channel remains primary.

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
3. Set the Telegram credentials with `pnpm wrangler secret put BOT_TOKEN` and `pnpm wrangler secret put CHAT_ID`.
4. Run `pnpm deploy`. The production `DEDUPE` KV namespace and both rate limiters are already declared in `wrangler.jsonc`.

Never commit `CHALLENGE_SECRET`, `BOT_TOKEN`, `CHAT_ID`, or a local `.dev.vars` file. Telegram failures are logged without lead data and do not break an already successful Google Forms submission.
