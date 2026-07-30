import { html } from "./html";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const SESSION_COOKIE = "__Host-meme_session";
const TRANSACTION_COOKIE = "__Host-meme_oauth";
const TRANSACTION_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 43_200;
const encoder = new TextEncoder();

interface SignedValue {
  payload: string;
  signature: string;
}

interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

interface SessionClaims {
  sub: string;
  email: string;
  exp: number;
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface GoogleClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  sub: string;
  email: string;
  email_verified: boolean;
  nonce: string;
  exp: number;
  iat: number;
  nbf?: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value");
  }
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomValue(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const material = encoder.encode(secret);
  if (material.byteLength < 32) throw new Error("AUTH_SESSION_SECRET must contain at least 32 bytes");
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function splitSignedValue(value: string): SignedValue | null {
  const separator = value.lastIndexOf(".");
  if (separator < 1 || separator === value.length - 1) return null;
  return { payload: value.slice(0, separator), signature: value.slice(separator + 1) };
}

async function verifySignedValue(value: string, secret: string): Promise<string | null> {
  const signed = splitSignedValue(value);
  if (!signed) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      arrayBuffer(base64UrlDecode(signed.signature)),
      encoder.encode(signed.payload)
    );
    return valid ? signed.payload : null;
  } catch {
    return null;
  }
}

function encodeObject(value: object): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function decodeObject(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function secureCookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string, path = "/"): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function authError(message: string, status = 400): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      }
    }
  );
}

function safeReturnTo(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://return.invalid");
    return parsed.origin === "https://return.invalid" ? `${parsed.pathname}${parsed.search}` : "/";
  } catch {
    return "/";
  }
}

function loginPage(returnTo: string): Response {
  const href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  return html(`<main class="login-shell"><section class="login-card"><p class="login-eyebrow">private meme library</p><h1>meme</h1><p>계속하려면 허용된 Google 계정으로 로그인하세요.</p><a class="google-login-button" href="${href}">Google로 로그인</a></section></main>`, 200, false);
}

function configuredRedirectUri(request: Request, env: Env): string {
  const redirectUri = new URL(env.GOOGLE_REDIRECT_URI);
  const requestUrl = new URL(request.url);
  if (redirectUri.protocol !== "https:" || redirectUri.origin !== requestUrl.origin || redirectUri.pathname !== "/auth/callback") {
    throw new Error("GOOGLE_REDIRECT_URI must be this Worker's HTTPS /auth/callback URL");
  }
  return redirectUri.toString();
}

function allowedEmails(env: Env): Set<string> {
  return new Set(env.GOOGLE_ALLOWED_EMAILS.split(",").map((email) => email.trim().toLocaleLowerCase()).filter(Boolean));
}

function validTransaction(value: unknown): value is OAuthTransaction {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.state === "string"
    && typeof item.nonce === "string"
    && typeof item.verifier === "string"
    && typeof item.returnTo === "string"
    && typeof item.exp === "number";
}

function validSession(value: unknown): value is SessionClaims {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.sub === "string"
    && typeof item.email === "string"
    && typeof item.exp === "number";
}

async function createTransaction(request: Request, env: Env, returnTo: string): Promise<Response> {
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue(48);
  const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const transaction: OAuthTransaction = {
    state,
    nonce,
    verifier,
    returnTo,
    exp: Math.floor(Date.now() / 1000) + TRANSACTION_TTL_SECONDS
  };
  const transactionValue = await signPayload(encodeObject(transaction), env.AUTH_SESSION_SECRET);
  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorization.searchParams.set("redirect_uri", configuredRedirectUri(request, env));
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email profile");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  return redirect(authorization.toString(), [
    secureCookie(TRANSACTION_COOKIE, transactionValue, TRANSACTION_TTL_SECONDS)
  ]);
}

function parseJwtPart(value: string): unknown {
  return decodeObject(value);
}

function validJwtHeader(value: unknown): value is JwtHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Record<string, unknown>;
  return header.alg === "RS256" && typeof header.kid === "string" && header.kid.length > 0;
}

function validGoogleClaims(value: unknown): value is GoogleClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return typeof claims.iss === "string"
    && (typeof claims.aud === "string" || (Array.isArray(claims.aud) && claims.aud.every((audience) => typeof audience === "string")))
    && (claims.azp === undefined || typeof claims.azp === "string")
    && typeof claims.sub === "string"
    && typeof claims.email === "string"
    && typeof claims.email_verified === "boolean"
    && typeof claims.nonce === "string"
    && typeof claims.exp === "number"
    && typeof claims.iat === "number"
    && (claims.nbf === undefined || typeof claims.nbf === "number");
}

async function googleVerificationKey(kid: string): Promise<CryptoKey> {
  const response = await fetch(JWKS_ENDPOINT, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Could not load Google signing keys");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).keys)) {
    throw new Error("Invalid Google signing keys");
  }
  const keys = (value as { keys: unknown[] }).keys;
  const key = keys.find((candidate): candidate is JsonWebKey => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return record.kid === kid && record.kty === "RSA" && record.use === "sig" && record.alg === "RS256";
  });
  if (!key) throw new Error("Google signing key was not found");
  return crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function verifyGoogleIdToken(token: string, env: Env, nonce: string): Promise<SessionClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("Invalid Google ID token");
  const headerValue = parseJwtPart(parts[0]);
  const claimsValue = parseJwtPart(parts[1]);
  if (!validJwtHeader(headerValue) || !validGoogleClaims(claimsValue)) throw new Error("Invalid Google ID token claims");

  const validSignature = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    await googleVerificationKey(headerValue.kid),
    arrayBuffer(base64UrlDecode(parts[2])),
    encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!validSignature) throw new Error("Invalid Google ID token signature");

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claimsValue.aud)
    ? claimsValue.aud.includes(env.GOOGLE_CLIENT_ID) && claimsValue.azp === env.GOOGLE_CLIENT_ID
    : claimsValue.aud === env.GOOGLE_CLIENT_ID;
  if (!audience
    || !["accounts.google.com", "https://accounts.google.com"].includes(claimsValue.iss)
    || claimsValue.exp <= now
    || claimsValue.iat > now + 60
    || (claimsValue.nbf !== undefined && claimsValue.nbf > now + 60)
    || claimsValue.nonce !== nonce
    || !claimsValue.email_verified) {
    throw new Error("Google ID token validation failed");
  }

  const email = claimsValue.email.toLocaleLowerCase();
  const allowed = allowedEmails(env);
  if (allowed.size === 0 || !allowed.has(email)) throw new Error("Google account is not allowed");
  return { sub: claimsValue.sub, email, exp: now + SESSION_TTL_SECONDS };
}

async function exchangeCode(request: Request, env: Env, code: string, transaction: OAuthTransaction): Promise<SessionClaims> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: configuredRedirectUri(request, env),
    grant_type: "authorization_code",
    code_verifier: transaction.verifier
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) throw new Error("Google authorization code exchange failed");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).id_token !== "string") {
    throw new Error("Google token response did not include an ID token");
  }
  return verifyGoogleIdToken((value as { id_token: string }).id_token, env, transaction.nonce);
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const transactionCookie = cookieValue(request, TRANSACTION_COOKIE);
  const signedPayload = transactionCookie ? await verifySignedValue(transactionCookie, env.AUTH_SESSION_SECRET) : null;
  let transaction: OAuthTransaction | null = null;
  if (signedPayload) {
    try {
      const value = decodeObject(signedPayload);
      if (validTransaction(value)) transaction = value;
    } catch {
      transaction = null;
    }
  }
  const clearTransaction = clearCookie(TRANSACTION_COOKIE);
  if (!transaction || transaction.exp <= Math.floor(Date.now() / 1000)) {
    return authError("Login session expired. Start again.", 401);
  }
  if (url.searchParams.get("state") !== transaction.state) return authError("Invalid OAuth state", 401);
  if (url.searchParams.has("error")) return authError("Google login was cancelled", 401);
  const code = url.searchParams.get("code");
  if (!code) return authError("Google authorization code is missing", 400);

  try {
    const claims = await exchangeCode(request, env, code, transaction);
    const sessionValue = await signPayload(encodeObject(claims), env.AUTH_SESSION_SECRET);
    return redirect(transaction.returnTo, [
      clearTransaction,
      secureCookie(SESSION_COOKIE, sessionValue, SESSION_TTL_SECONDS)
    ]);
  } catch (error) {
    console.error(JSON.stringify({ event: "google_oauth_callback_failed", error: String(error) }));
    const response = authError("Google login failed", 401);
    response.headers.append("set-cookie", clearTransaction);
    return response;
  }
}

export async function createSessionValue(claims: SessionClaims, secret: string): Promise<string> {
  return signPayload(encodeObject(claims), secret);
}

async function validRequestSession(request: Request, env: Env): Promise<boolean> {
  const sessionCookie = cookieValue(request, SESSION_COOKIE);
  const payload = sessionCookie ? await verifySignedValue(sessionCookie, env.AUTH_SESSION_SECRET) : null;
  if (!payload) return false;
  try {
    const value = decodeObject(payload);
    return validSession(value)
      && value.exp > Math.floor(Date.now() / 1000)
      && value.sub.length > 0
      && allowedEmails(env).has(value.email.toLocaleLowerCase());
  } catch {
    return false;
  }
}

export async function authenticate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/assets/app.css") return null;
  if (request.method === "GET" && url.pathname === "/auth/callback") return callback(request, env);
  if (request.method === "GET" && url.pathname === "/auth/logout") {
    return redirect("/", [clearCookie(SESSION_COOKIE), clearCookie(TRANSACTION_COOKIE)]);
  }
  if (request.method === "GET" && url.pathname === "/auth/login") {
    return createTransaction(request, env, safeReturnTo(url.searchParams.get("return_to")));
  }
  if (await validRequestSession(request, env)) return null;
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) {
    return authError("Authentication required", 401);
  }
  return loginPage(safeReturnTo(`${url.pathname}${url.search}`));
}
