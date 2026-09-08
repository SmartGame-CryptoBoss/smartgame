import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, telegramText, validateLead } from '../src/index.js';

const ORIGIN = 'https://smartgame.club';
const IP = '203.0.113.20';
const START_TIME = 1_788_800_000_000;

const validPayload = {
  name: 'Тест SmartGame',
  phone: '+380931112233',
  telegram: '',
  level: 'Новачок',
  interest: 'Навчання',
  goal: 'Перевірка захищеної форми',
  privacyConsent: true,
  website: '',
  challenge: '',
  source: {
    pageUrl: 'https://smartgame.club/?utm_source=instagram&utm_medium=social&utm_campaign=autumn',
    referrer: 'https://www.google.com/',
    utmSource: 'instagram',
    utmMedium: 'social',
    utmCampaign: 'autumn',
    utmContent: 'story',
    utmTerm: 'crypto club'
  }
};

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

const makeEnv = (overrides = {}) => ({
  CHALLENGE_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
  GOOGLE_FORM_ENDPOINT: 'https://docs.google.com/forms/d/e/test-form/formResponse',
  BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI',
  CHAT_ID: '-1001234567890',
  ATTEMPT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  LEAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
  DEDUPE: new MemoryKv(),
  ...overrides
});

const requestFor = (payload, { method = 'POST', origin = ORIGIN, ip = IP } = {}) => new Request('https://smartgame-leads.example/', {
  method,
  headers: {
    Origin: origin,
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    'User-Agent': 'SmartGame-test'
  },
  body: method === 'POST' ? JSON.stringify(payload) : undefined
});

const issueChallenge = async (env, now = START_TIME, ip = IP) => {
  const request = new Request('https://smartgame-leads.example/challenge', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip }
  });
  const response = await handleRequest(request, env, {
    now: () => now,
    uuid: () => '01234567-89ab-cdef-0123-456789abcdef'
  });
  assert.equal(response.status, 200);
  return (await response.json()).challenge;
};

const protectedPayload = async (env, overrides = {}) => ({
  ...validPayload,
  ...overrides,
  challenge: await issueChallenge(env)
});

const successfulDeliveryFetch = (calls = []) => async (url, options) => {
  calls.push({ url: String(url), options });
  if (String(url).startsWith('https://api.telegram.org/')) {
    return Response.json({ ok: true, result: { message_id: 1 } });
  }
  return new Response(null, { status: 204 });
};

test('server validation accepts the real SmartGame field options', () => {
  assert.equal(validateLead(validPayload).ok, true);
  assert.equal(validateLead({ ...validPayload, phone: '', telegram: '@smart_game' }).ok, true);
});

test('server validation rejects malformed fields', () => {
  assert.equal(validateLead({ ...validPayload, name: '1' }).code, 'invalid_name');
  assert.equal(validateLead({ ...validPayload, phone: '123' }).code, 'invalid_phone');
  assert.equal(validateLead({ ...validPayload, level: 'robot' }).code, 'invalid_level');
  assert.equal(validateLead({ ...validPayload, interest: 'spam' }).code, 'invalid_interest');
  assert.equal(validateLead({ ...validPayload, privacyConsent: false }).code, 'consent_required');
  assert.equal(validateLead({ ...validPayload, goal: 'x'.repeat(601) }).code, 'invalid_payload');
  assert.equal(validateLead({ ...validPayload, source: { ...validPayload.source, pageUrl: 'https://spam.example/' } }).code, 'invalid_source');
});

test('honeypot silently filters a bot without delivery', async () => {
  let outboundCalls = 0;
  const env = makeEnv();
  const response = await handleRequest(requestFor({ ...validPayload, website: 'https://spam.example' }), env, {
    now: () => START_TIME,
    fetchImpl: async () => { outboundCalls += 1; return new Response(null, { status: 204 }); }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(outboundCalls, 0);
});

test('submission faster than three seconds is blocked before delivery', async () => {
  let outboundCalls = 0;
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 1_000,
    fetchImpl: async () => { outboundCalls += 1; return new Response(null, { status: 204 }); }
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'too_fast');
  assert.equal(outboundCalls, 0);
});

test('challenge is bound to the originating IP', async () => {
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload, { ip: '198.51.100.42' }), env, {
    now: () => START_TIME + 4_000
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'challenge_invalid');
});

test('valid protected submission reaches Google Forms and then Telegram with all fields', async () => {
  const calls = [];
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: successfulDeliveryFetch(calls)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, channel: 'google_forms', telegramDelivered: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/docs\.google\.com\/forms\//);
  assert.match(String(calls[0].options.body), /entry\.1386002898=/);
  assert.match(String(calls[0].options.body), /entry\.1792378795=/);
  assert.equal(calls[1].url, 'https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI/sendMessage');
  const telegramBody = JSON.parse(calls[1].options.body);
  assert.equal(telegramBody.chat_id, '-1001234567890');
  assert.equal(telegramBody.parse_mode, 'HTML');
  assert.match(telegramBody.text, /Нова заявка SmartGame/);
  assert.match(telegramBody.text, /Тест SmartGame/);
  assert.match(telegramBody.text, /\+380931112233/);
  assert.match(telegramBody.text, /Новачок/);
  assert.match(telegramBody.text, /Перевірка захищеної форми/);
  assert.match(telegramBody.text, /instagram/);
  assert.match(telegramBody.text, /story/);
  assert.match(telegramBody.text, /Europe\/Kyiv/);
});

test('an identical lead is acknowledged but not delivered twice to either channel', async () => {
  const calls = [];
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const dependencies = {
    now: () => START_TIME + 4_000,
    fetchImpl: successfulDeliveryFetch(calls)
  };
  const first = await handleRequest(requestFor(payload), env, dependencies);
  const second = await handleRequest(requestFor(payload), env, dependencies);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  assert.equal(calls.length, 2);
});

test('Google Forms failure skips Telegram and keeps the existing delivery error', async () => {
  const calls = [];
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 500 });
    }
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, code: 'delivery_failed' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/docs\.google\.com\/forms\//);
});

test('Telegram failure does not break an already successful Google Forms submission', async () => {
  const calls = [];
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).startsWith('https://api.telegram.org/')
        ? new Response(null, { status: 502 })
        : new Response(null, { status: 204 });
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, channel: 'google_forms', telegramDelivered: false });
  assert.equal(calls.length, 2);
});

test('invalid Telegram configuration is not sent to the API or exposed to the frontend', async () => {
  const calls = [];
  const env = makeEnv({ BOT_TOKEN: 'invalid-token' });
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: successfulDeliveryFetch(calls)
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, channel: 'google_forms', telegramDelivered: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/docs\.google\.com\/forms\//);
});

test('Telegram message escapes user-controlled HTML', () => {
  const text = telegramText(
    { ...validPayload, name: 'Тест <Admin>', goal: 'A & B' },
    validPayload.source,
    START_TIME
  );
  assert.match(text, /Тест &lt;Admin&gt;/);
  assert.match(text, /A &amp; B/);
  assert.doesNotMatch(text, /Тест <Admin>/);
});

test('maximum validated fields fit within the Telegram message limit', () => {
  const text = telegramText(
    {
      ...validPayload,
      name: 'А'.repeat(80),
      phone: '',
      telegram: `@${'a'.repeat(31)}`,
      level: 'Є досвід',
      interest: 'Безкоштовна консультація',
      goal: 'Г'.repeat(600)
    },
    {
      pageUrl: `https://smartgame.club/?q=${'p'.repeat(472)}`,
      referrer: `https://example.com/?q=${'r'.repeat(477)}`,
      utmSource: 's'.repeat(100),
      utmMedium: 'm'.repeat(100),
      utmCampaign: 'c'.repeat(150),
      utmContent: 'o'.repeat(150),
      utmTerm: 't'.repeat(150)
    },
    START_TIME
  );
  assert.ok(text.length <= 4_096);
});

test('rate limiting blocks before challenge validation and delivery', async () => {
  let outboundCalls = 0;
  const env = makeEnv({
    ATTEMPT_RATE_LIMITER: { limit: async () => ({ success: false }) }
  });
  const response = await handleRequest(requestFor(validPayload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: async () => { outboundCalls += 1; return new Response(null, { status: 204 }); }
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'rate_limited');
  assert.equal(outboundCalls, 0);
});

test('accepted-lead rate limiting blocks both delivery channels', async () => {
  let outboundCalls = 0;
  const env = makeEnv({
    LEAD_RATE_LIMITER: { limit: async () => ({ success: false }) }
  });
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: async () => { outboundCalls += 1; return new Response(null, { status: 204 }); }
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'lead_rate_limited');
  assert.equal(outboundCalls, 0);
});

test('requests from another origin cannot obtain a challenge or submit', async () => {
  const env = makeEnv();
  const challengeResponse = await handleRequest(new Request('https://smartgame-leads.example/challenge', {
    headers: { Origin: 'https://spam.example', 'CF-Connecting-IP': IP }
  }), env);
  const submitResponse = await handleRequest(requestFor(validPayload, { origin: 'https://spam.example' }), env);
  assert.equal(challengeResponse.status, 403);
  assert.equal(submitResponse.status, 403);
});
