import { describe, expect, it, vi } from "vitest";
import { addItem, mediaRequestLogs, purgeExpiredMediaRequestLogs } from "../src/db";

describe("public collection metadata", () => {
  it("updates only the representative row for a legacy duplicate blob", async () => {
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

    const id = await addItem(env, {
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
  });
});

describe("media request log queries", () => {
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

    await mediaRequestLogs(env, 100, 200, 150, 42, 101);

    expect(sql).toContain("l.requested_at < ? OR (l.requested_at = ? AND l.id < ?)");
    expect(sql).toContain("ORDER BY l.requested_at DESC, l.id DESC");
    expect(values).toEqual([100, 200, 150, 150, 42, 101]);
    expect(sql).not.toContain("owner_sub");
  });

  it("purges expired logs in bounded batches", async () => {
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

    await purgeExpiredMediaRequestLogs(env);

    expect(sql).toContain("requested_at < unixepoch() - ?");
    expect(sql).toContain("LIMIT 10000");
  });
});
