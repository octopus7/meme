import { chmodSync, writeFileSync } from "node:fs";

const output = process.argv[2] ?? ".wrangler.generated.jsonc";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

const config = {
  main: "src/index.ts",
  compatibility_date: "2026-07-30",
  name: required("WEB_WORKER_NAME"),
  workers_dev: true,
  preview_urls: false,
  cache: { enabled: false },
  observability: { enabled: true },
  vars: {
    IMAGE_ORIGIN: required("IMAGE_ORIGIN"),
    ORIGIN_ADMIN_BASE_URL: required("ORIGIN_ADMIN_BASE_URL"),
    CF_ZONE_ID: required("CF_ZONE_ID"),
    GOOGLE_CLIENT_ID: required("GOOGLE_CLIENT_ID"),
    GOOGLE_REDIRECT_URI: required("GOOGLE_REDIRECT_URI"),
    GOOGLE_ALLOWED_EMAILS: required("GOOGLE_ALLOWED_EMAILS"),
    MAX_UPLOAD_BYTES: "20971520",
  },
  secrets: {
    required: [
      "GOOGLE_CLIENT_SECRET",
      "AUTH_SESSION_SECRET",
      "ORIGIN_ADMIN_TOKEN",
      "CF_CACHE_PURGE_TOKEN",
    ],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: required("D1_DATABASE_NAME"),
      database_id: required("D1_DATABASE_ID"),
      migrations_dir: "../../database/d1/migrations",
    },
  ],
  triggers: {
    crons: ["*/10 * * * *"],
  },
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
});
if (process.platform !== "win32") chmodSync(output, 0o600);
