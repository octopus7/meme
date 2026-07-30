import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { User } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamBaseUrl(value: string): URL {
  const raw = value.trim();
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function keySet(base: URL): ReturnType<typeof createRemoteJWKSet> {
  const key = base.origin;
  let value = keySets.get(key);
  if (!value) {
    value = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", base));
    keySets.set(key, value);
  }
  return value;
}

function readUser(payload: JWTPayload): User {
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Access token has no subject");
  }
  const email = payload.email;
  if (typeof email !== "string" || !email) {
    throw new Error("Access token has no email");
  }
  return { sub: payload.sub, email };
}

export async function authenticate(request: Request, env: Env): Promise<User> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Access assertion");

  const base = teamBaseUrl(env.ACCESS_TEAM_DOMAIN);
  const { payload } = await jwtVerify(token, keySet(base), {
    issuer: base.origin,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256"]
  });
  return readUser(payload);
}
