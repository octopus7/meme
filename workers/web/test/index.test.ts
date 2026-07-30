import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createSessionValue } from "../src/auth";

const authEnv = Object.assign({} as Env, {
  GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URI: "https://meme.example/auth/callback",
  GOOGLE_ALLOWED_EMAILS: "owner@example.com",
  AUTH_SESSION_SECRET: "test-session-secret-with-at-least-32-characters"
});

describe("authenticated web worker", () => {
  it("redirects an unauthenticated request to Google", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/search"),
      authEnv
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe(authEnv.GOOGLE_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(authEnv.GOOGLE_REDIRECT_URI);
    expect(location.searchParams.get("state")).not.toBe("");
    expect(location.searchParams.get("nonce")).not.toBe("");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.headers.get("set-cookie")).toContain("__Host-meme_oauth=");
  });

  it("serves a protected asset with a valid session", async () => {
    const session = await createSessionValue({
      sub: "google-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/assets/search.js", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      authEnv
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toBe("");
  });

  it("rejects a tampered session", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/search", {
        headers: { cookie: "__Host-meme_session=invalid.signature" }
      }),
      authEnv
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
  });
});
