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
  it("shows a login button for an unauthenticated root request", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/"),
      authEnv
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Google로 로그인");
    expect(body).toContain('href="/auth/login?return_to=%2F"');
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("redirects to Google only after the login button is used", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/auth/login?return_to=%2Fsearch"),
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
    const transactionCookie = response.headers.get("set-cookie");
    expect(transactionCookie).toContain("__Host-meme_oauth=");
    expect(transactionCookie).toContain("Path=/;");
    expect(transactionCookie).not.toContain("Path=/auth/callback");
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

  it("renders search without deployment tail and uses a list icon link", async () => {
    const session = await createSessionValue({
      sub: "google-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/search", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      authEnv
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('id="deployment-info"');
    expect(body).not.toContain("/assets/deployment.js");
    expect(body).toContain('aria-label="전체 목록"');
    expect(body).toContain("📋");
  });

  it("renders the all page as a gallery with logout", async () => {
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = () => statement;
    statement.all = async <T>() => ({
      success: true,
      results: [] as T[],
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0
      }
    });
    const db = Object.create(null) as D1Database;
    db.prepare = () => statement;
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "google-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/all", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('class="all-toolbar"');
    expect(body).toContain('href="/auth/logout">로그아웃</a>');
    expect(body).toContain('class="gallery"');
    expect(body).toContain("아직 등록된 이미지가 없습니다.");
    expect(body).toContain('id="deployment-info"');
  });

  it("serves baked deployment metadata with a valid session", async () => {
    const session = await createSessionValue({
      sub: "google-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/assets/deployment-info.json", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      authEnv
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      commitSha: "development"
    });
  });

  it("rejects a tampered session", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/search", {
        headers: { cookie: "__Host-meme_session=invalid.signature" }
      }),
      authEnv
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google로 로그인");
  });

  it("returns 401 for an unauthenticated API request", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/api/search?q=test"),
      authEnv
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });
});
