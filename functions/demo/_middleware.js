/**
 * HTTP Basic Auth gate for everything under /demo/*.
 *
 * One shared password, read from the `DEMO_PASSWORD` environment variable
 * (set it in the Cloudflare dashboard: Pages → misen-space → Settings →
 * Variables and Secrets → add `DEMO_PASSWORD` as a Secret, then redeploy).
 * The username is ignored — visitors can type anything for the username and
 * the shared password to get in.
 *
 * Open by default: if DEMO_PASSWORD is not configured, the demo is public.
 * Set the secret to instantly switch on the Basic Auth gate (no redeploy of
 * source needed).
 */

const REALM = 'Misen demo';

function unauthorized(msg) {
  return new Response(msg || 'Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  });
}

// Constant-time-ish string comparison to avoid leaking content via timing.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export const onRequest = async (context) => {
  const { request, env, next } = context;
  const expected = env.DEMO_PASSWORD;

  // No password configured → demo is OPEN. To lock it down later, just add a
  // `DEMO_PASSWORD` secret in the Pages project settings (no code change /
  // redeploy of source needed) and the Basic Auth gate below activates.
  if (!expected) {
    return next();
  }

  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch { decoded = ''; }
    const sep = decoded.indexOf(':');
    const password = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (safeEqual(password, expected)) {
      // Authenticated — let the request fall through to the static asset.
      return next();
    }
  }

  return unauthorized();
};
