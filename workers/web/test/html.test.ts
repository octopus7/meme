import { describe, expect, it } from "vitest";
import { LOGS_JS, UPLOAD_JS } from "../src/assets";
import { allLink, assetScript, assetStyle, escapeHtml, highlight, html, uploadForm } from "../src/html";
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

  it("adds deployment information by default", async () => {
    const response = html("<main>content</main>");
    const body = await response.text();

    expect(body).toContain('id="deployment-info"');
    expect(body).toContain('src="/assets/deployment.js?v=development"');
    expect(body).toContain('href="/assets/app.css?v=development"');
    expect(assetStyle("/assets/admin.css")).toBe('<link rel="stylesheet" href="/assets/admin.css?v=development">');
  });

  it("can omit deployment information and renders an accessible list icon", async () => {
    const response = html(`<main>${allLink()}</main>`, 200, false);
    const body = await response.text();

    expect(body).not.toContain('id="deployment-info"');
    expect(body).not.toContain("/assets/deployment.js");
    expect(body).toContain('<a href="/all" aria-label="전체 목록" title="전체 목록">📋</a>');
  });

  it("renders a collapsed upload form with a visible description label", () => {
    const markup = uploadForm(true);

    expect(markup).toContain('<details class="upload-panel">');
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("<summary>upload</summary>");
    expect(markup).toContain('<label>설명 <input name="description"');
    expect(markup).toContain('id="upload-form"');
    expect(markup).toContain('id="upload-console"');
    expect(markup).toContain('role="log"');
  });

  it("versions browser assets and logs every upload phase", () => {
    expect(assetScript("/assets/upload.js")).toContain("/assets/upload.js?v=development");
    expect(() => new Function(UPLOAD_JS)).not.toThrow();
    expect(UPLOAD_JS).toContain("POST /api/images 전송 시작");
    expect(UPLOAD_JS).toContain("r.status");
    expect(UPLOAD_JS).toContain("await r.text()");
    expect(UPLOAD_JS).toContain('log("ERROR"');
    expect(UPLOAD_JS).toContain('log("DONE"');
  });

  it("formats log times in the browser timezone and submits epoch ranges", () => {
    expect(() => new Function(LOGS_JS)).not.toThrow();
    expect(LOGS_JS).toContain("Intl.DateTimeFormat");
    expect(LOGS_JS).toContain("Math.floor(a.getTime()/1000)");
  });
});
