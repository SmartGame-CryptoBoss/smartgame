import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, validateLead } from '../src/index.js';

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
  challenge: ''
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

test('valid protected submission reaches Google Forms once', async () => {
  let outboundCalls = 0;
  let sentBody = '';
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const response = await handleRequest(requestFor(payload), env, {
    now: () => START_TIME + 4_000,
    fetchImpl: async (_url, options) => {
      outboundCalls += 1;
      sentBody = String(options.body);
      return new Response(null, { status: 204 });
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, channel: 'google_forms' });
  assert.equal(outboundCalls, 1);
  assert.match(sentBody, /entry\.1386002898=/);
  assert.match(sentBody, /entry\.1792378795=/);
});

test('an identical lead is acknowledged but not delivered twice', async () => {
  let outboundCalls = 0;
  const env = makeEnv();
  const payload = await protectedPayload(env);
  const dependencies = {
    now: () => START_TIME + 4_000,
    fetchImpl: async () => {
      outboundCalls += 1;
      return new Response(null, { status: 204 });
    }
  };
  const first = await handleRequest(requestFor(payload), env, dependencies);
  const second = await handleRequest(requestFor(payload), env, dependencies);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  assert.equal(outboundCalls, 1);
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

test('requests from another origin cannot obtain a challenge or submit', async () => {
  const env = makeEnv();
  const challengeResponse = await handleRequest(new Request('https://smartgame-leads.example/challenge', {
    headers: { Origin: 'https://spam.example', 'CF-Connecting-IP': IP }
  }), env);
  const submitResponse = await handleRequest(requestFor(validPayload, { origin: 'https://spam.example' }), env);
  assert.equal(challengeResponse.status, 403);
  assert.equal(submitResponse.status, 403);
});
