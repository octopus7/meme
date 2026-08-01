import { describe, expect, it, vi } from "vitest";
import {
  addItem,
  adoptLegacyItems,
  imageUrlExposures,
  list,
  purgeExpiredImageUrlExposures,
  search,
  writeImageUrlExposures,
} from "../src/db";

describe("owned collection metadata", () => {
  it("updates only the current owner's row for a duplicate blob", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const prepare = vi.fn((sql: string): D1PreparedStatement => {
      const statement: D1PreparedStatement = Object.create(null);
      statement.bind = (...values: unknown[]) => {
        statements.push({ sql, values });
        return statement;
      };
      statement.first = async <T>() => (
        sql.startsWith("SELECT state")
          ? { state: "active" }
          : { id: "representative-id" }
      ) as T;
      statement.run = async <T>() => Object.create(null) as D1Result<T>;
      return statement;
    });
    const env: Env = Object.create(null);
    env.DB = Object.create(null);
    env.DB.prepare = prepare;

    const id = await addItem(env, "owner-sub", "owner@example.com", {
      hash: "a".repeat(64),
      extension: "png",
      mimeType: "image/png",
      size: 42
    }, "updated", "image.png");

    expect(id).toBe("representative-id");
    expect(statements.at(-1)).toEqual({
      sql: "UPDATE image_items SET description=?, original_filename=? WHERE id=?",
      values: ["updated", "image.png", "representative-id"]
    });
    expect(statements.every(({ sql }) => !sql.includes("UPDATE image_items SET description=?, original_filename=? WHERE blob_hash=?"))).toBe(true);
    expect(statements).toContainEqual({
      sql: "SELECT id FROM image_items WHERE owner_sub=? AND blob_hash=?",
      values: ["owner-sub", "a".repeat(64)]
    });
  });

  it("adopts legacy public rows for the authenticated administrator", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        statements.push({ sql, values });
        return statement;
      };
      statement.first = async <T>() => ({ found: 1 }) as T;
      return statement;
    };
    db.batch = async <T>(batch: D1PreparedStatement[]) => batch.map(() => Object.create(null) as D1Result<T>);
    const env = Object.assign(Object.create(null), { DB: db }) as Env;

    await adoptLegacyItems(env, "admin-sub", "owner@example.com");

    expect(statements).toHaveLength(3);
    expect(statements[0]?.values).toEqual(["public"]);
    expect(statements[1]?.values).toEqual(["public", "admin-sub"]);
    expect(statements[2]?.values).toEqual(["admin-sub", "owner@example.com", "public"]);
  });

  it("scopes list and search queries to the current owner", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        queries.push({ sql, values });
        return statement;
      };
      statement.all = async <T>() => ({ success: true, results: [] as T[], meta: Object.create(null) });
      return statement;
    };
    const env = Object.assign(Object.create(null), { DB: db }) as Env;

    await list(env, "member-sub", null, 51);
    await search(env, "member-sub", "cat", 100);

    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("i.owner_sub=?");
    expect(queries[0]?.values).toEqual(["member-sub", 51]);
    expect(queries[1]?.sql).toContain("i.owner_sub = ?");
    expect(queries[1]?.values).toEqual(["member-sub", "%cat%", "%cat%", 100]);
  });
});

describe("image URL exposure log queries", () => {
  it("uses a stable timestamp and id cursor", async () => {
    let sql = "";
    let values: unknown[] = [];
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = (...bound: unknown[]) => {
      values = bound;
      return statement;
    };
    statement.all = async <T>() => ({
      success: true,
      results: [] as T[],
      meta: Object.create(null)
    });
    const env = Object.create(null) as Env;
    env.DB = Object.create(null) as D1Database;
    env.DB.prepare = (query: string) => {
      sql = query;
      return statement;
    };

    await imageUrlExposures(env, 100, 200, 150, 42, 101);

    expect(sql).toContain("e.exposed_at < ? OR (e.exposed_at = ? AND e.id < ?)");
    expect(sql).toContain("ORDER BY e.exposed_at DESC, e.id DESC");
    expect(values).toEqual([100, 200, 150, 150, 42, 101]);
    expect(sql).not.toContain("owner_sub");
  });

  it("writes one row per image URL exposure", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = Object.create(null) as D1Database;
    db.prepare = (sql: string) => {
      const statement = Object.create(null) as D1PreparedStatement;
      statement.bind = (...values: unknown[]) => {
        statements.push({ sql, values });
        return statement;
      };
      return statement;
    };
    db.batch = async <T>(batch: D1PreparedStatement[]) => batch.map(() => Object.create(null) as D1Result<T>);
    const env = Object.assign(Object.create(null), { DB: db }) as Env;
    const row = {
      id: "item-1",
      description: "sample",
      blob_hash: "a".repeat(64),
      extension: "png",
      original_filename: "sample.png",
      byte_size: 42,
      created_at: "2026-01-01T00:00:00Z",
    };

    await writeImageUrlExposures(env, [row, row], "viewer-sub", "search");

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("image_url_exposure_logs");
    expect(statements[0]?.values.slice(1)).toEqual([
      "item-1", "a".repeat(64), "sample.png", 42, "search", "viewer-sub",
    ]);
  });

  it("purges expired exposure logs in bounded batches", async () => {
    let sql = "";
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = () => statement;
    statement.run = async <T>() => Object.create(null) as D1Result<T>;
    const env = Object.create(null) as Env;
    env.DB = Object.create(null) as D1Database;
    env.DB.prepare = (query: string) => {
      sql = query;
      return statement;
    };

    await purgeExpiredImageUrlExposures(env);

    expect(sql).toContain("exposed_at < unixepoch() - ?");
    expect(sql).toContain("LIMIT 10000");
  });
});
