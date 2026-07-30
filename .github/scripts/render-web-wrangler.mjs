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
  workers_dev: false,
  preview_urls: false,
  cache: { enabled: false },
  observability: { enabled: true },
  vars: {
    ACCESS_TEAM_DOMAIN: required("ACCESS_TEAM_DOMAIN"),
    ACCESS_AUD: required("ACCESS_AUD"),
    IMAGE_ORIGIN: required("IMAGE_ORIGIN"),
    MAX_UPLOAD_BYTES: "20971520",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: required("D1_DATABASE_NAME"),
      database_id: required("D1_DATABASE_ID"),
      migrations_dir: "../../database/d1/migrations",
    },
  ],
  services: [
    {
      binding: "STORAGE_ADMIN",
      service: required("STORAGE_WORKER_NAME"),
      entrypoint: "Admin",
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
