// POST /api/signup — append an email to the SIGNUPS KV namespace.
//
// Wire-up in Cloudflare Pages:
//   Settings → Functions → KV namespace bindings
//   Variable name:  SIGNUPS
//   KV namespace:   <pick or create one — see README>
//
// Stored as one key per signup:
//   key:   email:<lowercased-email>
//   value: JSON { email, ts, ip, ua, referrer }
// A duplicate signup returns 409 without overwriting the timestamp.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const raw = (payload && payload.email) || '';
  const email = String(raw).trim().toLowerCase();

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  if (!env.SIGNUPS) {
    // KV binding missing — fail loud so it's obvious during setup, but
    // still ack the user so dev mode isn't broken.
    console.error('Missing KV binding: SIGNUPS');
    return json({ error: 'Signups are temporarily disabled.' }, 503);
  }

  const key = `email:${email}`;
  const existing = await env.SIGNUPS.get(key);
  if (existing) {
    return json({ error: 'Already subscribed.' }, 409);
  }

  const record = {
    email,
    ts: new Date().toISOString(),
    ip: request.headers.get('cf-connecting-ip') || null,
    ua: request.headers.get('user-agent') || null,
    referrer: request.headers.get('referer') || null,
  };

  await env.SIGNUPS.put(key, JSON.stringify(record));

  return json({
    ok: true,
    message: 'Got it — thanks. I\'ll be in touch.',
  });
}

// Reject anything that isn't a POST.
export async function onRequest({ request }) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }
}
