import { ADMIN_CSS, ALL_JS, APP_CSS, DEPLOYMENT_JS, EXPOSURES_JS, SEARCH_JS, UPLOAD_JS } from "./assets";
import { authenticate, configuredAdminEmail, isAdministrator, type SessionClaims } from "./auth";
import {
  addItem,
  adoptLegacyItems,
  encodeCursor,
  externalMembersAllowed,
  imageUrlExposures,
  list,
  purgeExpiredImageUrlExposures,
  search,
  searchTerms,
  setExternalMembersAllowed,
  type ImageRow,
  type ExposureContext,
  writeImageUrlExposures,
} from "./db";
import deploymentInfo from "./deployment-info.generated.json";
import { allLink, assetScript, assetStyle, escapeHtml, highlight, html, textBytes, uploadForm } from "./html";
import { originAdminFetch, purgeMediaCache } from "./origin-admin";
import type { StoredBlob } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };
const EXPOSURE_PAGE_SIZE = 100;
const EXPOSURE_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const SEARCH_RESULT_LIMIT = 100;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: JSON_HEADERS });
}

function imageOrigin(env: Env): string {
  return env.IMAGE_ORIGIN.replace(/\/+$/u, "");
}

function imageMarkup(row: ImageRow, env: Env, terms: string[] = [], deletable = false): string {
  const hash = encodeURIComponent(row.blob_hash);
  const ext = encodeURIComponent(row.extension);
  const origin = escapeHtml(imageOrigin(env));
  const remove = deletable ? `<button class="delete-button" type="button" data-delete="${escapeHtml(row.id)}">삭제</button>` : "";
  return `<article class="meme-card"><a class="meme-image" href="${origin}/i/${hash}.${ext}"><img src="${origin}/t/${hash}" width="320" height="320" loading="lazy" alt=""></a><div class="meme-card-body"><p class="meme-description">${highlight(row.description, terms)}</p>${remove}</div></article>`;
}

function exposureRange(url: URL): {
  from: number;
  to: number;
  beforeAt: number | null;
  beforeId: number | null;
} {
  const now = Math.floor(Date.now() / 1000);
  const parse = (name: string): number | null => {
    const value = url.searchParams.get(name);
    if (value === null) return null;
    if (!/^\d{1,12}$/u.test(value)) throw new Error(`Invalid ${name}`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${name}`);
    return number;
  };
  const to = parse("to") ?? now + 1;
  const from = parse("from") ?? to - 24 * 60 * 60;
  const beforeAt = parse("before_at");
  const beforeId = parse("before_id");
  if ((beforeAt === null) !== (beforeId === null)
    || from >= to
    || to - from > EXPOSURE_RETENTION_SECONDS
    || to > now + 60) {
    throw new Error("Invalid log range");
  }
  return { from, to, beforeAt, beforeId };
}

function exposureRowsMarkup(rows: Awaited<ReturnType<typeof imageUrlExposures>>, env: Env): string {
  if (!rows.length) return `<p class="empty-state">선택한 구간의 이미지 URL 노출 기록이 없습니다.</p>`;
  const body = rows.map((row) => {
    const imageUrl = `${imageOrigin(env)}/t/${encodeURIComponent(row.blob_hash)}`;
    return `<tr><td><time data-epoch="${row.exposed_at}">${escapeHtml(new Date(row.exposed_at * 1000).toISOString())}</time></td><td><a class="hash-link" href="${escapeHtml(imageUrl)}" title="${escapeHtml(row.blob_hash)}">${escapeHtml(row.original_filename)}</a></td><td>${row.byte_size.toLocaleString()} bytes</td><td>${escapeHtml(row.exposure_context)}</td><td>${escapeHtml(row.viewer_sub)}</td></tr>`;
  }).join("");
  return `<div class="table-scroll"><table class="log-table"><thead><tr><th>시각</th><th>파일</th><th>크기</th><th>화면</th><th>사용자</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

async function recordImageUrlExposures(
  env: Env,
  rows: ImageRow[],
  viewerSub: string,
  context: ExposureContext,
  executionContext?: ExecutionContext,
): Promise<void> {
  if (!rows.length) return;
  const operation = writeImageUrlExposures(env, rows, viewerSub, context).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "image_url_exposure_log_failed", context, error: String(error) }));
  });
  if (executionContext) executionContext.waitUntil(operation);
  else await operation;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function sameOriginForm(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function decodeHeader(request: Request, name: string): string {
  const value = request.headers.get(name) ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

function validBlob(value: unknown): value is StoredBlob {
  if (!value || typeof value !== "object") return false;
  const blob = value as Record<string, unknown>;
  return typeof blob.hash === "string" && /^[a-f0-9]{64}$/u.test(blob.hash)
    && typeof blob.extension === "string" && /^[a-z0-9]{2,5}$/u.test(blob.extension)
    && typeof blob.mimeType === "string" && blob.mimeType.startsWith("image/")
    && typeof blob.size === "number" && Number.isSafeInteger(blob.size) && blob.size >= 0;
}

async function upload(request: Request, env: Env, owner: SessionClaims): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden origin" }, 403);
  const length = Number(request.headers.get("content-length"));
  const max = Number(env.MAX_UPLOAD_BYTES ?? "20971520");
  if (!Number.isSafeInteger(length) || length < 1) return json({ error: "Content-Length is required" }, 411);
  if (length > max) return json({ error: "Image is too large" }, 413);
  if (!request.body) return json({ error: "Image body is required" }, 400);

  let description: string;
  let filename: string;
  try {
    description = decodeHeader(request, "x-description").trim();
    filename = decodeHeader(request, "x-original-filename").trim();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid metadata" }, 400);
  }
  if (!description || description.length > 500 || textBytes(description) > 2000) {
    return json({ error: "Description must be 1-500 characters" }, 400);
  }
  if (!filename || filename.length > 255 || textBytes(filename) > 1024) {
    return json({ error: "Filename must be 1-255 characters" }, 400);
  }

  const originResponse = await originAdminFetch(env, "/internal/v1/blobs", {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(length)
    },
    body: request.body
  });
  if (!originResponse.ok) {
    return json({ error: "Image origin rejected the upload" }, originResponse.status >= 400 && originResponse.status < 500 ? originResponse.status : 502);
  }
  const value: unknown = await originResponse.json();
  if (!validBlob(value)) return json({ error: "Invalid response from image origin" }, 502);
  try {
    const id = await addItem(env, owner.sub, owner.email, value, description, filename);
    return json({ id, hash: value.hash }, 201);
  } catch (error) {
    console.error(JSON.stringify({ event: "metadata_write_failed", hash: value.hash, error: String(error) }));
    return json({ error: "Could not save image metadata" }, 409);
  }
}

async function removeImage(id: string, request: Request, env: Env, ownerSub: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden origin" }, 403);
  const row = await env.DB.prepare(
    "SELECT blob_hash FROM image_items WHERE id=? AND (owner_sub=? OR owner_sub='public')",
  ).bind(id, ownerSub).first<{ blob_hash: string }>();
  if (!row) return json({ error: "Not found" }, 404);

  await env.DB.prepare("DELETE FROM image_items WHERE id=?").bind(id).run();
  await env.DB.prepare(
    `UPDATE blobs SET state='trash_pending'
     WHERE hash=? AND state='active'
       AND NOT EXISTS (SELECT 1 FROM image_items WHERE blob_hash=?)`
  ).bind(row.blob_hash, row.blob_hash).run();
  const blob = await env.DB.prepare("SELECT state FROM blobs WHERE hash=?")
    .bind(row.blob_hash).first<{ state: string }>();
  if (blob?.state !== "trash_pending") return new Response(null, { status: 204 });

  const trashed = await trashBlob(env, row.blob_hash);
  if (!trashed) return json({ error: "Deleted; image origin cleanup is pending" }, 202);
  return new Response(null, { status: 204 });
}

async function trashBlob(env: Env, hash: string): Promise<boolean> {
  try {
    const response = await originAdminFetch(env, `/internal/v1/blobs/${hash}/trash`, { method: "POST" });
    if (!response.ok && response.status !== 404 && response.status !== 409) return false;
    await purgeMediaCache(env, hash);
    await env.DB.prepare(
      "UPDATE blobs SET state='trashed', trashed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), purge_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days') WHERE hash=? AND state='trash_pending'"
    ).bind(hash).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "trash_failed", hash, error: String(error) }));
    return false;
  }
}

async function retryPendingTrash(env: Env): Promise<void> {
  const pending = await env.DB.prepare("SELECT hash FROM blobs WHERE state='trash_pending' LIMIT 50").all<{ hash: string }>();
  for (const row of pending.results) await trashBlob(env, row.hash);
}

async function route(
  request: Request,
  env: Env,
  session: SessionClaims | null,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const administrator = session !== null && isAdministrator(env, session.email);
  if (request.method === "GET" && url.pathname === "/") return Response.redirect(new URL("/all", url), 302);
  if (request.method === "GET" && url.pathname === "/assets/search.js") {
    return new Response(SEARCH_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/upload.js") {
    return new Response(UPLOAD_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/all.js") {
    return new Response(ALL_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/deployment.js") {
    return new Response(DEPLOYMENT_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/exposures.js") {
    if (!administrator) return json({ error: "Not found" }, 404);
    return new Response(EXPOSURES_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/admin.css") {
    if (!administrator) return json({ error: "Not found" }, 404);
    return new Response(ADMIN_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/app.css") {
    return new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/deployment-info.json") {
    return new Response(JSON.stringify(deploymentInfo), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/search") {
    return html(`<main class="search-page"><form role="search"><input name="q" aria-label="검색어" autocomplete="off"></form><p>${allLink()}</p><div id="results" class="search-grid" aria-live="polite"></div></main>${assetScript("/assets/search.js")}`, 200, false);
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    if (!session) return json({ error: "Authentication required" }, 401);
    if (administrator) await adoptLegacyItems(env, session.sub, session.email);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if (!query) return new Response("", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
    const rows = await search(env, session.sub, query, SEARCH_RESULT_LIMIT);
    await recordImageUrlExposures(env, rows, session.sub, "search", executionContext);
    const body = rows.map((row) => imageMarkup(row, env, searchTerms(query))).join("");
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/all") {
    if (!session) return json({ error: "Authentication required" }, 401);
    if (administrator) await adoptLegacyItems(env, session.sub, session.email);
    let rows: ImageRow[];
    try {
      rows = await list(env, session.sub, url.searchParams.get("cursor"), 51);
    } catch {
      return html("<p>잘못된 페이지 주소입니다.</p>", 400);
    }
    const hasMore = rows.length > 50;
    const visible = rows.slice(0, 50);
    await recordImageUrlExposures(env, visible, session.sub, "all", executionContext);
    const next = hasMore && visible.length ? `<p class="next-page"><a href="/all?cursor=${encodeURIComponent(encodeCursor(visible[visible.length - 1]!))}">다음</a></p>` : "";
    const gallery = visible.length
      ? visible.map((row) => imageMarkup(row, env, [], administrator)).join("")
      : `<p class="empty-state">아직 등록된 이미지가 없습니다.</p>`;
    const adminLink = administrator
      ? `<a class="icon-link" href="/admin" aria-label="관리자" title="관리자">⚙️</a>`
      : "";
    return html(`<div class="all-shell"><header class="all-toolbar"><a class="brand" href="/all">meme</a><nav class="toolbar-actions" aria-label="주요 메뉴">${adminLink}<a class="toolbar-link" href="/search">🔎 검색</a><a class="logout-button" href="/auth/logout">로그아웃</a></nav></header><main class="all-page">${uploadForm(true)}<section class="gallery" aria-label="이미지 목록">${gallery}</section>${next}</main></div>${assetScript("/assets/upload.js")}${assetScript("/assets/all.js")}`);
  }
  if (request.method === "GET" && url.pathname === "/admin") {
    if (!administrator) return json({ error: "Not found" }, 404);
    const allowExternal = await externalMembersAllowed(env);
    const checked = allowExternal ? " checked" : "";
    const state = allowExternal ? "현재 허용됨" : "현재 차단됨";
    return html(`${assetStyle("/assets/admin.css")}<div class="all-shell"><header class="all-toolbar"><a class="brand" href="/all">meme</a><nav class="toolbar-actions" aria-label="주요 메뉴"><a class="toolbar-link" href="/all">📋 목록</a><a class="logout-button" href="/auth/logout">로그아웃</a></nav></header><main class="admin-page"><h1>관리자</h1><section class="admin-card"><h2>이미지 URL 노출 기록</h2><p>web Worker가 목록과 검색 결과에 이미지 URL을 포함한 시각을 확인합니다. 실제 이미지 다운로드와 캐시 상태는 기록하지 않습니다.</p><a class="primary-link" href="/exposures">노출 기록 보기</a></section><section class="admin-card"><h2>외부 회원 로그인</h2><p>관리자 <strong>${escapeHtml(configuredAdminEmail(env))}</strong>는 항상 허용됩니다. 이 설정을 끄면 일반 회원의 기존 세션도 다음 요청부터 차단됩니다.</p><form class="member-setting" method="post" action="/admin/settings"><label><input type="checkbox" name="allow_external"${checked}> 관리자 외 Google 회원 로그인 허용</label><strong>${state}</strong><button type="submit">설정 저장</button></form></section></main></div>`);
  }
  if (request.method === "POST" && url.pathname === "/admin/settings") {
    if (!administrator) return json({ error: "Not found" }, 404);
    if (!sameOriginForm(request)) return json({ error: "Forbidden origin" }, 403);
    const lengthHeader = request.headers.get("content-length");
    const length = lengthHeader === null ? null : Number(lengthHeader);
    if ((length !== null && (!Number.isSafeInteger(length) || length < 1 || length > 1024))
      || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return json({ error: "Invalid form body" }, 400);
    }
    const form = await request.formData();
    await setExternalMembersAllowed(env, form.get("allow_external") === "on");
    return new Response(null, {
      status: 303,
      headers: { location: "/admin", "cache-control": "private, no-store" },
    });
  }
  if (request.method === "GET" && url.pathname === "/exposures") {
    if (!administrator) return json({ error: "Not found" }, 404);
    let range: ReturnType<typeof exposureRange>;
    try {
      range = exposureRange(url);
    } catch {
      return html("<p>잘못된 노출 기록 조회 구간입니다.</p>", 400);
    }
    const rows = await imageUrlExposures(
      env,
      range.from,
      range.to,
      range.beforeAt,
      range.beforeId,
      EXPOSURE_PAGE_SIZE + 1,
    );
    const visible = rows.slice(0, EXPOSURE_PAGE_SIZE);
    const nextParams = new URLSearchParams({
      from: String(range.from),
      to: String(range.to),
    });
    if (rows.length > EXPOSURE_PAGE_SIZE && visible.length) {
      const last = visible[visible.length - 1]!;
      nextParams.set("before_at", String(last.exposed_at));
      nextParams.set("before_id", String(last.id));
    }
    const next = rows.length > EXPOSURE_PAGE_SIZE
      ? `<p class="next-page"><a href="/exposures?${escapeHtml(nextParams.toString())}">다음 기록</a></p>`
      : "";
    const quickRanges = [1, 7, 30, 90].map((days) => {
      const params = new URLSearchParams({
        from: String(range.to - days * 24 * 60 * 60),
        to: String(range.to),
      });
      return `<a href="/exposures?${escapeHtml(params.toString())}">${days === 1 ? "24시간" : `${days}일`}</a>`;
    }).join("");
    return html(`${assetStyle("/assets/admin.css")}<div class="all-shell"><header class="all-toolbar"><a class="brand" href="/all">meme</a><nav class="toolbar-actions" aria-label="주요 메뉴"><a class="toolbar-link" href="/admin">⚙️ 관리자</a><a class="toolbar-link" href="/all">📋 목록</a><a class="logout-button" href="/auth/logout">로그아웃</a></nav></header><main class="exposures-page"><h1>이미지 URL 노출 기록</h1><form id="log-filter" class="log-filter" method="get" action="/exposures"><label>시작 시각<input id="log-from" type="datetime-local" required></label><label>종료 시각<input id="log-to" type="datetime-local" required></label><input type="hidden" name="from" value="${range.from}"><input type="hidden" name="to" value="${range.to}"><button type="submit">조회</button></form><nav class="range-links" aria-label="빠른 조회 구간">${quickRanges}</nav><section class="log-section"><h2>URL 노출 기록</h2>${exposureRowsMarkup(visible, env)}${next}</section></main></div>${assetScript("/assets/exposures.js")}`);
  }
  if (request.method === "GET" && url.pathname === "/upload") {
    return html(`<nav><a href="/search">search</a> ${allLink()}</nav><main>${uploadForm()}</main>${assetScript("/assets/upload.js")}`);
  }
  if (request.method === "POST" && url.pathname === "/api/images") {
    if (!session) return json({ error: "Authentication required" }, 401);
    if (administrator) await adoptLegacyItems(env, session.sub, session.email);
    return upload(request, env, session);
  }
  const match = /^\/api\/images\/([0-9a-f-]{36})$/u.exec(url.pathname);
  if (request.method === "DELETE" && match?.[1]) {
    if (!administrator) return json({ error: "Not found" }, 404);
    if (request.headers.get("origin") !== url.origin) return json({ error: "Forbidden origin" }, 403);
    if (!session) return json({ error: "Authentication required" }, 401);
    return removeImage(match[1], request, env, session.sub);
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, executionContext?: ExecutionContext): Promise<Response> {
    try {
      const authentication = await authenticate(request, env);
      if (authentication.response) return authentication.response;
      return await route(request, env, authentication.session, executionContext);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname, error: String(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      retryPendingTrash(env),
      purgeExpiredImageUrlExposures(env),
    ]).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;
