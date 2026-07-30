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
  name: required("STORAGE_WORKER_NAME"),
  workers_dev: true,
  preview_urls: false,
  observability: { enabled: true },
  cache: {
    enabled: false,
    cross_version_cache: true,
  },
  exports: {
    default: {
      type: "worker",
      cache: { enabled: false },
    },
    Media: {
      type: "worker",
      cache: { enabled: true },
    },
    Admin: {
      type: "worker",
      cache: { enabled: false },
    },
  },
  vpc_services: [
    {
      binding: "ORIGIN",
      service_id: required("VPC_SERVICE_ID"),
    },
  ],
  vars: {
    ORIGIN_BASE_URL: required("ORIGIN_BASE_URL"),
  },
  secrets: {
    required: ["ORIGIN_ADMIN_TOKEN"],
  },
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
});
if (process.platform !== "win32") chmodSync(output, 0o600);
