import { describe, expect, it } from "vitest";
import { escapeHtml, highlight, html } from "../src/html";
import { searchTerms } from "../src/db";

describe("HTML helpers", () => {
  it("escapes untrusted text", () => {
    expect(escapeHtml(`<img src=x onerror="x">`)).toBe("&lt;img src=x onerror=&quot;x&quot;&gt;");
  });

  it("highlights terms without allowing markup", () => {
    expect(highlight("<고양이>", ["고양"])).toBe("&lt;<mark>고양</mark>이&gt;");
  });

  it("deduplicates and limits search terms", () => {
    expect(searchTerms(" a  a b ")).toEqual(["a", "b"]);
  });

  it("adds deployment information to every HTML page", async () => {
    const response = html("<main>content</main>");
    const body = await response.text();

    expect(body).toContain('id="deployment-info"');
    expect(body).toContain('src="/assets/deployment.js"');
  });
});
