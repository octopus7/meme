import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { configuredAdminEmail, createSessionValue } from "../src/auth";

const authEnv = Object.assign({} as Env, {
  GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URI: "https://meme.example/auth/callback",
  GOOGLE_ALLOWED_EMAILS: "owner@example.com",
  AUTH_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  IMAGE_ORIGIN: "https://images.example"
});

describe("authenticated web worker", () => {
  function emptyDb(setting = "false"): D1Database {
    const db = Object.create(null) as D1Database;
    db.prepare = () => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = () => statement;
      statement.first = async <T>() => ({ value: setting }) as T;
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
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    };
    return db;
  }

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

  it("lands an authenticated root request on the user's collection", async () => {
    const session = await createSessionValue({
      sub: "google-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      authEnv
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://meme.example/all");
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

  it("keeps administrator page styles out of the public stylesheet", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/assets/app.css"),
      authEnv
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(".admin-page");
    expect(body).not.toContain(".logs-page");
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
    expect(body).toContain('class="search-page"');
    expect(body).toContain('class="search-grid"');
    expect(body).toContain('aria-live="polite"');
  });

  it("uses compact fixed-size thumbnails for search results", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/assets/app.css"),
      authEnv
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("grid-template-columns:repeat(auto-fill,44px)");
    expect(body).toContain(".search-grid .meme-card{width:44px;height:44px");
    expect(body).toContain(".search-grid .meme-card-body{display:none}");
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
    statement.first = async <T>() => null as T;
    const db = Object.create(null) as D1Database;
    db.prepare = () => statement;
    db.batch = async <T>(statements: D1PreparedStatement[]) => statements.map(() => Object.create(null) as D1Result<T>);
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
    expect(body).toContain('href="/admin"');
    expect(body).toContain("⚙️");
    expect(body).toContain('id="deployment-info"');
  });

  it("hides administrator and statistics features from an external member", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("true") });
    const session = await createSessionValue({
      sub: "member-user-id",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const headers = { cookie: `__Host-meme_session=${session}` };

    const all = await worker.fetch(new Request("https://meme.example/all", { headers }), env);
    const body = await all.text();
    expect(all.status).toBe(200);
    expect(body).not.toContain("/admin");
    expect(body).not.toContain("/logs");
    expect(body).not.toContain("관리자");
    expect(body).not.toContain("통계");
    expect(body).not.toContain("data-delete");

    for (const path of ["/admin", "/logs", "/assets/logs.js", "/assets/admin.css"]) {
      const response = await worker.fetch(new Request(`https://meme.example${path}`, { headers }), env);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });

  it("passes the authenticated member id into list and search queries", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        queries.push({ sql, values });
        return statement;
      };
      statement.first = async <T>() => ({ value: "true" }) as T;
      statement.all = async <T>() => ({ success: true, results: [] as T[], meta: Object.create(null) });
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "member-user-id",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const headers = { cookie: `__Host-meme_session=${session}` };

    expect((await worker.fetch(new Request("https://meme.example/all", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://meme.example/api/search?q=cat", { headers }), env)).status).toBe(200);

    expect(queries.some(({ sql, values }) => sql.includes("i.owner_sub=?")
      && values[0] === "member-user-id" && values.at(-1) === 51)).toBe(true);
    expect(queries.some(({ sql, values }) => sql.includes("i.owner_sub = ?")
      && values[0] === "member-user-id" && values.at(-1) === 100)).toBe(true);
  });

  it("immediately rejects an external member when external login is disabled", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "member-user-id",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/all", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google로 로그인");
  });

  it("renders the administrator page and statistics link only for the administrator", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/admin", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("owner@example.com");
    expect(body).toContain('href="/logs"');
    expect(body).toContain('action="/admin/settings"');
    expect(body).toContain("/assets/admin.css");
    expect(body).not.toContain(" checked>");
  });

  it("lets only the administrator change the external member setting", async () => {
    let saved: unknown[] = [];
    const db = Object.create(null) as D1Database;
    db.prepare = () => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        saved = values;
        return statement;
      };
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const body = new URLSearchParams({ allow_external: "on" });
    const response = await worker.fetch(
      new Request("https://meme.example/admin/settings", {
        method: "POST",
        headers: {
          cookie: `__Host-meme_session=${session}`,
          origin: "https://meme.example"
        },
        body
      }),
      env
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    expect(saved).toEqual(["true"]);
  });

  it("accepts a same-origin form Referer when the browser omits Origin", async () => {
    let saved: unknown[] = [];
    const db = Object.create(null) as D1Database;
    db.prepare = () => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        saved = values;
        return statement;
      };
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/admin/settings", {
        method: "POST",
        headers: {
          cookie: `__Host-meme_session=${session}`,
          referer: "https://meme.example/admin"
        },
        body: new URLSearchParams({ allow_external: "on" })
      }),
      env
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    expect(saved).toEqual(["true"]);
  });

  it("accepts same-origin Fetch Metadata when privacy settings omit Origin and Referer", async () => {
    let saved: unknown[] = [];
    const db = Object.create(null) as D1Database;
    db.prepare = () => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        saved = values;
        return statement;
      };
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/admin/settings", {
        method: "POST",
        headers: {
          cookie: `__Host-meme_session=${session}`,
          "sec-fetch-site": "same-origin"
        },
        body: new URLSearchParams({ allow_external: "on" })
      }),
      env
    );

    expect(response.status).toBe(303);
    expect(saved).toEqual(["true"]);
  });

  it("rejects administrator setting changes without an exact Origin", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/admin/settings", {
        method: "POST",
        headers: { cookie: `__Host-meme_session=${session}` },
        body: new URLSearchParams({ allow_external: "on" })
      }),
      env
    );

    expect(response.status).toBe(403);
  });

  it("does not allow an external member to delete images", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("true") });
    const session = await createSessionValue({
      sub: "member-user-id",
      email: "member@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/api/images/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );

    expect(response.status).toBe(404);
  });

  it("requires an exact Origin for administrator deletes", async () => {
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/api/images/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );

    expect(response.status).toBe(403);
  });

  it("deletes only the administrator's item row, not every owner of the blob", async () => {
    const hash = "a".repeat(64);
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        queries.push({ sql, values });
        return statement;
      };
      statement.first = async <T>() => (
        sql.startsWith("SELECT blob_hash") ? { blob_hash: hash } : { state: "active" }
      ) as T;
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const id = "00000000-0000-0000-0000-000000000000";
    const response = await worker.fetch(
      new Request(`https://meme.example/api/images/${id}`, {
        method: "DELETE",
        headers: {
          cookie: `__Host-meme_session=${session}`,
          origin: "https://meme.example"
        }
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(queries).toContainEqual({
      sql: "DELETE FROM image_items WHERE id=?",
      values: [id]
    });
    expect(queries.some(({ sql }) => sql === "DELETE FROM image_items WHERE blob_hash=?")).toBe(false);
  });

  it("renders log rows and statistics for the administrator", async () => {
    const hash = "a".repeat(64);
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = () => statement;
      statement.all = async <T>() => ({
        success: true,
        results: (sql.includes("GROUP BY")
          ? [{
              blob_hash: hash,
              extension: "png",
              description: "sample",
              total_requests: 4,
              cache_hits: 3,
              cache_misses: 1,
              cache_other: 0,
              response_errors: 0
            }]
          : [{
              id: 1,
              requested_at: Math.floor(Date.now() / 1000) - 10,
              blob_hash: hash,
              media_kind: "original",
              request_method: "GET",
              cache_status: "HIT",
              response_status: 200,
              colo: "ICN",
              extension: "png",
              description: "sample"
            }]) as T[],
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
      return statement;
    };
    const env = Object.assign({}, authEnv, { DB: db });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request("https://meme.example/logs", {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("파일별 캐시 통계");
    expect(body).toContain("HIT율");
    expect(body).toContain("75.0%");
    expect(body).toContain("ICN");
    expect(body).toContain("/assets/logs.js");
  });

  it("rejects log ranges longer than the 90 day retention window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: now + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request(`https://meme.example/logs?from=${now - 91 * 86400}&to=${now}`, {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it("accepts a 90 day quick range after a short page delay", async () => {
    const now = Math.floor(Date.now() / 1000);
    const to = now - 30;
    const from = to - 90 * 86400;
    const env = Object.assign({}, authEnv, { DB: emptyDb("false") });
    const session = await createSessionValue({
      sub: "admin-user-id",
      email: "owner@example.com",
      exp: now + 60
    }, authEnv.AUTH_SESSION_SECRET);
    const response = await worker.fetch(
      new Request(`https://meme.example/logs?from=${from}&to=${to}`, {
        headers: { cookie: `__Host-meme_session=${session}` }
      }),
      env
    );

    expect(response.status).toBe(200);
  });

  it("requires exactly one configured administrator email", () => {
    expect(configuredAdminEmail(authEnv)).toBe("owner@example.com");
    expect(() => configuredAdminEmail({
      ...authEnv,
      GOOGLE_ALLOWED_EMAILS: "one@example.com,two@example.com"
    })).toThrow("exactly one administrator email");
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
