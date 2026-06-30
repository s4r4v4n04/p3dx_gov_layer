/**
 * Keycloak service-account token provider for gov_layer -> FL receiver calls.
 *
 * gov_layer talks to two unauthenticated control-plane receivers:
 *   - provider_config_receiver.py    (data provider, :8080)  /update-config, /start-client, /provision-env
 *   - output_owner_env_receiver.py   (output owner,  :8090)  /provision-env, /start-server, /start-session
 *
 * These endpoints run scripts, so they must be authenticated. Instead of one
 * shared secret (PUSH_AUTH_TOKEN / X-Auth-Token), gov_layer authenticates as a
 * Keycloak SERVICE ACCOUNT using the OAuth2 client-credentials grant and sends
 * the resulting access token as `Authorization: Bearer <jwt>`. The receivers
 * validate it via Keycloak token introspection before doing anything.
 *
 * Config (env — same names/realm as the p3dx-aaa stack):
 *   KEYCLOAK_TOKEN_URL      full token endpoint (optional; derived from the two below)
 *   KEYCLOAK_BASE_URL       e.g. http://localhost:8080
 *   KEYCLOAK_REALM          e.g. master
 *   KEYCLOAK_CLIENT_ID      service-account client id (e.g. gov-layer)
 *   KEYCLOAK_CLIENT_SECRET  service-account client secret
 *   KEYCLOAK_TOKEN_TIMEOUT_MS  token request timeout (default 8000)
 *
 * If Keycloak is not configured, callers fall back to the legacy static
 * PUSH_AUTH_TOKEN (X-Auth-Token) so existing deployments keep working.
 */

const TOKEN_URL =
  process.env.KEYCLOAK_TOKEN_URL ||
  (process.env.KEYCLOAK_BASE_URL && process.env.KEYCLOAK_REALM
    ? `${process.env.KEYCLOAK_BASE_URL.replace(/\/$/, "")}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`
    : "");
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || "";
const TOKEN_TIMEOUT_MS = Number(process.env.KEYCLOAK_TOKEN_TIMEOUT_MS || 8000);
// Refresh a little before the token actually expires so an in-flight request
// never carries an already-expired token.
const EXPIRY_SKEW_MS = 30000;

export function keycloakConfigured() {
  return Boolean(TOKEN_URL && CLIENT_ID && CLIENT_SECRET);
}

// Cached token: { accessToken, expiresAt }. `inflight` dedupes concurrent fetches
// so the parallel Promise.all fan-outs (one per provider) share a single request.
let cached = null;
let inflight = null;

async function fetchToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = await resp.text(); } catch { /* ignore */ }
    throw new Error(`Keycloak token request failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("Keycloak token response had no access_token");
  const ttlMs = (Number(data.expires_in) || 60) * 1000;
  return { accessToken: data.access_token, expiresAt: Date.now() + ttlMs };
}

/**
 * Return a valid service-account access token, fetching/refreshing as needed.
 * Returns null when Keycloak is not configured. Throws if a configured fetch fails.
 */
export async function getServiceToken() {
  if (!keycloakConfigured()) return null;
  if (cached && Date.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached.accessToken;
  if (!inflight) {
    inflight = fetchToken()
      .then((t) => { cached = t; return t.accessToken; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Build request headers for a call to an FL receiver, attaching auth:
 *   - If Keycloak is configured: `Authorization: Bearer <service-account token>`.
 *   - Else if `fallbackToken` is set: the legacy `X-Auth-Token` header.
 *   - Else: just `base` (open — matches the receiver's no-auth mode).
 * `base` carries Content-Type etc. Never throws: if the token fetch fails it logs
 * and returns `base` unchanged, so the receiver replies 401 and the per-target
 * result records the failure (rather than crashing the whole fan-out).
 */
export async function authHeaders(base = {}, fallbackToken = "") {
  const headers = { ...base };
  if (keycloakConfigured()) {
    try {
      const token = await getServiceToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        return headers;
      }
    } catch (e) {
      console.error(`[KEYCLOAK] service-account token fetch failed: ${e.message}`);
    }
  }
  if (fallbackToken) headers["X-Auth-Token"] = fallbackToken;
  return headers;
}
