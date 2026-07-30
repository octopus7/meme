import { chmodSync, writeFileSync } from "node:fs";

const output = process.argv[2] ?? ".wrangler.generated.jsonc";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

const config = {
  name: "meme-d1-migration-runner",
  main: "src/index.ts",
  compatibility_date: "2026-07-30",
  d1_databases: [
    {
      binding: "DB",
      database_name: required("D1_DATABASE_NAME"),
      database_id: required("D1_DATABASE_ID"),
      migrations_dir: "../../database/d1/migrations",
    },
  ],
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
});
if (process.platform !== "win32") chmodSync(output, 0o600);
