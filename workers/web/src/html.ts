const encoder = new TextEncoder();

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char] ?? char);
}

export function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>meme</title><body>${body}<footer><small id="deployment-info">배포 정보 확인 중…</small></footer><script src="/assets/deployment.js" defer></script></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; img-src https:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

export function uploadForm(collapsible = false): string {
  const content = `<form id="upload-form"><p><label>이미지 <input name="image" type="file" accept="image/*" required></label></p><p><label>설명 <input name="description" maxlength="500" required></label></p><button>upload</button></form><p id="upload-message" role="status"></p>`;
  return collapsible ? `<details><summary>upload</summary>${content}</details>` : content;
}

export function textBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function highlight(description: string, terms: string[]): string {
  if (terms.length === 0) return escapeHtml(description);
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const lower = description.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of ordered) {
    const needle = term.toLocaleLowerCase();
    let from = 0;
    while (needle && from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let output = "";
  let position = 0;
  for (const [start, end] of merged) {
    output += escapeHtml(description.slice(position, start));
    output += `<mark>${escapeHtml(description.slice(start, end))}</mark>`;
    position = end;
  }
  return output + escapeHtml(description.slice(position));
}
