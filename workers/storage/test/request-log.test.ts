import { describe, expect, it, vi } from "vitest";
import { writeMediaRequestLog } from "../src/request-log";

const hash = "b".repeat(64);

describe("media request logging", () => {
  it("writes the cache result without request credentials", async () => {
    const values: unknown[][] = [];
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = (...bound: unknown[]) => {
      values.push(bound);
      return statement;
    };
    statement.run = async <T>() => Object.create(null) as D1Result<T>;
    const env = Object.create(null) as Env;
    env.DB = Object.create(null) as D1Database;
    env.DB.prepare = vi.fn(() => statement);

    await writeMediaRequestLog(
      env,
      new Request(`https://images.example/t/${hash}`, {
        headers: { authorization: "Bearer secret" },
      }),
      { hash, path: `/t/${hash}`, kind: "thumbnail" },
      new Response("image", {
        status: 200,
        headers: { "cf-cache-status": "hit" },
      }),
    );

    expect(values).toHaveLength(1);
    expect(values[0]!.slice(1)).toEqual([
      hash,
      "thumbnail",
      "GET",
      "HIT",
      200,
      null,
    ]);
    expect(values[0]).not.toContain("Bearer secret");
  });

  it("records UNKNOWN when the cache header is unavailable", async () => {
    let values: unknown[] = [];
    const statement = Object.create(null) as D1PreparedStatement;
    statement.bind = (...bound: unknown[]) => {
      values = bound;
      return statement;
    };
    statement.run = async <T>() => Object.create(null) as D1Result<T>;
    const env = Object.create(null) as Env;
    env.DB = Object.create(null) as D1Database;
    env.DB.prepare = vi.fn(() => statement);

    await writeMediaRequestLog(
      env,
      new Request(`https://images.example/i/${hash}.png`, { method: "HEAD" }),
      { hash, path: `/i/${hash}.png`, kind: "original" },
      new Response(null, { status: 404 }),
    );

    expect(values[4]).toBe("UNKNOWN");
    expect(values[3]).toBe("HEAD");
    expect(values[5]).toBe(404);
  });
});
