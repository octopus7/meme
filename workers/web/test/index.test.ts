import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("public web worker", () => {
  it("serves public routes without authentication headers", async () => {
    const response = await worker.fetch(
      new Request("https://meme.example/assets/search.js"),
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toBe("");
  });
});
