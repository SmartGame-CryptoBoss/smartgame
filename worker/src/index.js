const ALLOWED_ORIGINS = new Set([
  'https://smartgame.club',
  'https://www.smartgame.club'
]);
const MAX_BODY_BYTES = 16_384;
const CHALLENGE_MIN_AGE_MS = 3_000;
const CHALLENGE_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const DUPLICATE_TTL_SECONDS = 10 * 60;
const TELEGRAM_TIMEOUT_MS = 8_000;
const LEVELS = new Set(['Новачок', 'Є досвід']);
const INTERESTS = new Set([
  'Навчання',
  'Клуб / інвест-кейси',
  'Ф’ючерси',
  'DeFi',
  'Безкоштовна консультація'
]);
const FORM_FIELDS = Object.freeze({
  name: 'entry.1386002898',
  contact: 'entry.1792378795',
  level: 'entry.1255105175',
  interest: 'entry.1774742956',
  goal: 'entry.1993426930',
  consent: 'entry.671553290'
});
const CONSENT_VALUE = 'Погоджуюся з Політикою конфіденційності smartgame.club/privacy.html';

const encoder = new TextEncoder();
const clean = (value) => String(value ?? '').trim().replace(/\r\n?/g, '\n');

const readBodyLimited = async (request, maxBytes) => {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('payload_too_large');
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
};

const json = (origin, body, status = 200, extraHeaders = {}) => {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
};

const bytesToBase64Url = (bytes) => {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const importChallengeKey = (secret, cryptoImpl) => cryptoImpl.subtle.importKey(
  'raw',
  encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify']
);

const challengeMessage = (issuedAt, nonce, ip) => `${issuedAt}.${nonce}.${ip}`;

export const createChallenge = async (ip, env, dependencies = {}) => {
  if (!env.CHALLENGE_SECRET || env.CHALLENGE_SECRET.length < 32) {
    throw new Error('protection_unavailable');
  }
  const cryptoImpl = dependencies.cryptoImpl || crypto;
  const now = dependencies.now || Date.now;
  const uuid = dependencies.uuid || (() => cryptoImpl.randomUUID());
  const issuedAt = now();
  const nonce = uuid();
  const key = await importChallengeKey(env.CHALLENGE_SECRET, cryptoImpl);
  const signature = await cryptoImpl.subtle.sign(
    'HMAC',
    key,
    encoder.encode(challengeMessage(issuedAt, nonce, ip))
  );
  return {
    token: `${issuedAt}.${nonce}.${bytesToBase64Url(new Uint8Array(signature))}`,
    issuedAt,
    minSubmitAt: issuedAt + CHALLENGE_MIN_AGE_MS
  };
};

export const verifyChallenge = async (token, ip, env, dependencies = {}) => {
  if (!env.CHALLENGE_SECRET || env.CHALLENGE_SECRET.length < 32) {
    return { ok: false, code: 'protection_unavailable' };
  }
  const value = clean(token);
  if (!value || value.length > 512) return { ok: false, code: 'challenge_missing' };
  const parts = value.split('.');
  if (parts.length !== 3) return { ok: false, code: 'challenge_invalid' };
  const [issuedAtRaw, nonce, signatureRaw] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt) || !/^[0-9a-f-]{20,64}$/i.test(nonce)) {
    return { ok: false, code: 'challenge_invalid' };
  }

  const cryptoImpl = dependencies.cryptoImpl || crypto;
  let signature;
  try {
    signature = base64UrlToBytes(signatureRaw);
  } catch {
    return { ok: false, code: 'challenge_invalid' };
  }

  const key = await importChallengeKey(env.CHALLENGE_SECRET, cryptoImpl);
  const validSignature = await cryptoImpl.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(challengeMessage(issuedAt, nonce, ip))
  );
  if (!validSignature) return { ok: false, code: 'challenge_invalid' };

  const now = (dependencies.now || Date.now)();
  const age = now - issuedAt;
  if (age < CHALLENGE_MIN_AGE_MS) {
    return { ok: false, code: 'too_fast', retryAfterMs: CHALLENGE_MIN_AGE_MS - Math.max(0, age) };
  }
  if (age > CHALLENGE_MAX_AGE_MS || issuedAt > now + 5_000) {
    return { ok: false, code: 'challenge_expired' };
  }
  return { ok: true };
};

const validString = (value, maxLength) => typeof value === 'string'
  && value.length <= maxLength
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);

const isValidPhone = (value) => /^\+?[\d\s().-]{7,24}$/.test(value)
  && value.replace(/\D/g, '').length >= 7
  && value.replace(/\D/g, '').length <= 15;
const isValidTelegram = (value) => /^@[a-zA-Z0-9_]{5,32}$/.test(value)
  || /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[a-zA-Z0-9_]{5,32}\/?$/i.test(value);

const normalizeSource = (input) => {
  const sourceInput = input?.source;
  if (sourceInput == null) {
    return { ok: true, source: { pageUrl: '', referrer: '', utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '' } };
  }
  if (typeof sourceInput !== 'object' || Array.isArray(sourceInput)) {
    return { ok: false, code: 'invalid_source' };
  }

  const fields = {
    pageUrl: [sourceInput.pageUrl, 500],
    referrer: [sourceInput.referrer, 500],
    utmSource: [sourceInput.utmSource, 100],
    utmMedium: [sourceInput.utmMedium, 100],
    utmCampaign: [sourceInput.utmCampaign, 150],
    utmContent: [sourceInput.utmContent, 150],
    utmTerm: [sourceInput.utmTerm, 150]
  };
  for (const [value, maxLength] of Object.values(fields)) {
    if (!validString(value ?? '', maxLength)) return { ok: false, code: 'invalid_source' };
  }
  const source = Object.fromEntries(
    Object.entries(fields).map(([name, [value]]) => [name, clean(value)])
  );

  if (source.pageUrl) {
    try {
      const pageUrl = new URL(source.pageUrl);
      if (pageUrl.protocol !== 'https:' || !ALLOWED_ORIGINS.has(pageUrl.origin)) {
        return { ok: false, code: 'invalid_source' };
      }
    } catch {
      return { ok: false, code: 'invalid_source' };
    }
  }
  if (source.referrer) {
    try {
      const referrer = new URL(source.referrer);
      if (!['http:', 'https:'].includes(referrer.protocol)) return { ok: false, code: 'invalid_source' };
    } catch {
      return { ok: false, code: 'invalid_source' };
    }
  }
  return { ok: true, source };
};

export const validateLead = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_payload' };
  }
  if (clean(input.website)) return { ok: false, code: 'spam_detected' };
  if (input.privacyConsent !== true) return { ok: false, code: 'consent_required' };

  const fields = {
    name: [input.name, 80],
    phone: [input.phone, 30],
    telegram: [input.telegram, 100],
    level: [input.level, 30],
    interest: [input.interest, 60],
    goal: [input.goal, 600]
  };
  for (const [value, maxLength] of Object.values(fields)) {
    if (!validString(value, maxLength)) return { ok: false, code: 'invalid_payload' };
  }

  const lead = Object.fromEntries(
    Object.entries(fields).map(([name, [value]]) => [name, clean(value)])
  );
  const nameLetters = lead.name.match(/[\p{L}\p{M}]/gu) || [];
  if (lead.name.length < 2
    || nameLetters.length < 2
    || !/^[\p{L}\p{M}][\p{L}\p{M} .’'’-]*$/u.test(lead.name)
    || /(?:https?:\/\/|www\.)/i.test(lead.name)) {
    return { ok: false, code: 'invalid_name' };
  }
  if (lead.phone && !isValidPhone(lead.phone)) return { ok: false, code: 'invalid_phone' };
  if (lead.telegram && !isValidTelegram(lead.telegram)) return { ok: false, code: 'invalid_telegram' };
  if ((!lead.phone && !lead.telegram) || (lead.phone && lead.telegram)) {
    return { ok: false, code: 'contact_required' };
  }
  if (!LEVELS.has(lead.level)) return { ok: false, code: 'invalid_level' };
  if (!INTERESTS.has(lead.interest)) return { ok: false, code: 'invalid_interest' };

  const sourceValidation = normalizeSource(input);
  if (!sourceValidation.ok) return sourceValidation;

  return { ok: true, lead, source: sourceValidation.source };
};

export const leadFingerprint = async (lead, cryptoImpl = crypto) => {
  const canonical = JSON.stringify([
    lead.name.toLocaleLowerCase('uk-UA'),
    lead.phone.replace(/[\s().-]/g, ''),
    lead.telegram.toLocaleLowerCase('en-US'),
    lead.level,
    lead.interest,
    lead.goal.replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
  ]);
  const digest = await cryptoImpl.subtle.digest('SHA-256', encoder.encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const sendToGoogleForms = async (lead, env, fetchImpl) => {
  if (!/^https:\/\/docs\.google\.com\/forms\/d\/e\/[a-zA-Z0-9_-]+\/formResponse$/.test(env.GOOGLE_FORM_ENDPOINT || '')) {
    return false;
  }
  const contact = lead.phone || lead.telegram;
  const body = new URLSearchParams({
    [FORM_FIELDS.name]: lead.name,
    [FORM_FIELDS.contact]: contact,
    [FORM_FIELDS.level]: lead.level,
    [FORM_FIELDS.interest]: lead.interest,
    [FORM_FIELDS.goal]: lead.goal,
    [FORM_FIELDS.consent]: CONSENT_VALUE,
    fvv: '1',
    pageHistory: '0'
  });
  const response = await fetchImpl(env.GOOGLE_FORM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000)
  });
  return response.ok || (response.status >= 300 && response.status < 400);
};

const escapeHtml = (value) => clean(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const telegramText = (lead, source, timestamp = Date.now()) => {
  const contactLines = [
    lead.phone ? `📞 <b>Телефон:</b> ${escapeHtml(lead.phone)}` : '',
    lead.telegram ? `💬 <b>Telegram:</b> ${escapeHtml(lead.telegram)}` : ''
  ].filter(Boolean);
  const utmLines = [
    ['utm_source', source.utmSource],
    ['utm_medium', source.utmMedium],
    ['utm_campaign', source.utmCampaign],
    ['utm_content', source.utmContent],
    ['utm_term', source.utmTerm]
  ].filter(([, value]) => value)
    .map(([label, value]) => `🏷 <b>${label}:</b> ${escapeHtml(value)}`);
  const sourceLines = [
    '🌐 <b>Джерело:</b> SmartGame',
    source.pageUrl ? `🔗 <b>Сторінка:</b> ${escapeHtml(source.pageUrl)}` : '',
    source.referrer ? `↩️ <b>Реферер:</b> ${escapeHtml(source.referrer)}` : '',
    ...utmLines
  ].filter(Boolean);
  const dateTime = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date(timestamp));

  return [
    '🔥 <b>Нова заявка SmartGame</b>',
    '',
    `👤 <b>Імʼя:</b> ${escapeHtml(lead.name)}`,
    ...contactLines,
    `📊 <b>Рівень:</b> ${escapeHtml(lead.level)}`,
    `🎯 <b>Цікавить:</b> ${escapeHtml(lead.interest)}`,
    `📝 <b>Мета:</b> ${escapeHtml(lead.goal) || '—'}`,
    '✅ <b>Згода:</b> Так',
    '',
    ...sourceLines,
    `🕒 <b>Дата/час:</b> ${escapeHtml(dateTime)} (Europe/Kyiv)`
  ].join('\n');
};

const sendToTelegram = async (lead, source, env, fetchImpl, timestamp) => {
  const botToken = clean(env.BOT_TOKEN);
  const chatId = clean(env.CHAT_ID);
  if (!/^\d{6,12}:[a-zA-Z0-9_-]{30,}$/.test(botToken) || !/^-?\d+$/.test(chatId)) {
    return { ok: false, reason: 'invalid_configuration' };
  }
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      chat_id: chatId,
      text: telegramText(lead, source, timestamp),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
  });
  const result = await response.json().catch(() => null);
  return {
    ok: response.ok && result?.ok === true,
    status: response.status,
    errorCode: Number(result?.error_code) || undefined,
    reason: clean(result?.description).slice(0, 160) || undefined
  };
};

const clientIp = (request) => clean(request.headers.get('CF-Connecting-IP')) || 'unknown';

export const handleRequest = async (request, env, dependencies = {}) => {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || Date.now;
  const uuid = dependencies.uuid;
  const cryptoImpl = dependencies.cryptoImpl || crypto;
  const origin = request.headers.get('Origin') || '';
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return json('', { ok: false, code: 'origin_not_allowed' }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
      }
    });
  }

  if (request.method === 'GET' && pathname === '/challenge') {
    if (!ALLOWED_ORIGINS.has(origin)) return json('', { ok: false, code: 'origin_not_allowed' }, 403);
    try {
      const challenge = await createChallenge(clientIp(request), env, { now, uuid, cryptoImpl });
      return json(origin, { ok: true, challenge: challenge.token, issuedAt: challenge.issuedAt, minSubmitAt: challenge.minSubmitAt });
    } catch {
      return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
    }
  }
  if (request.method === 'GET') return json('', { ok: true, service: 'SmartGame Leads', protected: true });
  if (request.method !== 'POST') return json(origin, { ok: false, code: 'method_not_allowed' }, 405);
  if (!ALLOWED_ORIGINS.has(origin)) return json('', { ok: false, code: 'origin_not_allowed' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return json(origin, { ok: false, code: 'json_required' }, 415);
  }

  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > MAX_BODY_BYTES) return json(origin, { ok: false, code: 'payload_too_large' }, 413);
  if (!env.ATTEMPT_RATE_LIMITER?.limit || !env.LEAD_RATE_LIMITER?.limit || !env.DEDUPE?.get || !env.DEDUPE?.put) {
    return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
  }

  const ip = clientIp(request);
  let attemptLimit;
  try {
    attemptLimit = await env.ATTEMPT_RATE_LIMITER.limit({ key: `ip:${ip}` });
  } catch {
    return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
  }
  if (!attemptLimit.success) {
    return json(origin, { ok: false, code: 'rate_limited' }, 429, { 'Retry-After': '60' });
  }

  let input;
  try {
    const rawBody = await readBodyLimited(request, MAX_BODY_BYTES);
    input = JSON.parse(rawBody);
  } catch (error) {
    if (error?.message === 'payload_too_large') {
      return json(origin, { ok: false, code: 'payload_too_large' }, 413);
    }
    return json(origin, { ok: false, code: 'invalid_json' }, 400);
  }

  if (clean(input?.website)) return json(origin, { ok: true });

  let challenge;
  try {
    challenge = await verifyChallenge(input?.challenge, ip, env, { now, cryptoImpl });
  } catch {
    return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
  }
  if (!challenge.ok) {
    const status = challenge.code === 'too_fast' ? 429
      : challenge.code === 'protection_unavailable' ? 503
        : 403;
    const retrySeconds = challenge.retryAfterMs ? Math.max(1, Math.ceil(challenge.retryAfterMs / 1_000)) : null;
    return json(
      origin,
      { ok: false, code: challenge.code },
      status,
      retrySeconds ? { 'Retry-After': String(retrySeconds) } : {}
    );
  }

  const validation = validateLead(input);
  if (!validation.ok) return json(origin, { ok: false, code: validation.code }, 422);

  const fingerprint = await leadFingerprint(validation.lead, cryptoImpl);
  const duplicateKey = `lead:${fingerprint}`;
  let duplicate;
  try {
    duplicate = await env.DEDUPE.get(duplicateKey);
  } catch {
    return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
  }
  if (duplicate) return json(origin, { ok: true, duplicate: true });

  let leadLimit;
  try {
    leadLimit = await env.LEAD_RATE_LIMITER.limit({ key: `ip:${ip}` });
  } catch {
    return json(origin, { ok: false, code: 'protection_unavailable' }, 503);
  }
  if (!leadLimit.success) {
    return json(origin, { ok: false, code: 'lead_rate_limited' }, 429, { 'Retry-After': '60' });
  }

  const googleDelivered = await sendToGoogleForms(validation.lead, env, fetchImpl).catch(() => false);
  if (!googleDelivered) return json(origin, { ok: false, code: 'delivery_failed' }, 502);

  const telegramResult = await sendToTelegram(
    validation.lead,
    validation.source,
    env,
    fetchImpl,
    now()
  ).catch((error) => ({
    ok: false,
    reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error'
  }));
  const telegramDelivered = telegramResult.ok;
  if (!telegramDelivered) {
    console.warn(JSON.stringify({
      event: 'telegram_delivery_failed',
      source: 'SmartGame',
      status: telegramResult.status,
      errorCode: telegramResult.errorCode,
      reason: telegramResult.reason
    }));
  }

  try {
    await env.DEDUPE.put(duplicateKey, '1', { expirationTtl: DUPLICATE_TTL_SECONDS });
  } catch {
    return json(origin, { ok: true, channel: 'google_forms', telegramDelivered, protectionDegraded: true });
  }
  return json(origin, { ok: true, channel: 'google_forms', telegramDelivered });
};

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
