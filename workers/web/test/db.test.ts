import { describe, expect, it, vi } from "vitest";
import { addItem } from "../src/db";

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
