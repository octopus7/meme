import { writeFileSync } from "node:fs";

const output = process.argv[2] ?? "src/deployment-info.generated.json";
const commitSha = process.env.GITHUB_SHA?.trim().toLowerCase();

if (!commitSha || !/^[0-9a-f]{40}$/u.test(commitSha)) {
  throw new Error("GITHUB_SHA must be a full 40-character Git commit SHA");
}

const deploymentInfo = {
  deployedAt: new Date().toISOString(),
  commitSha,
  runId: process.env.GITHUB_RUN_ID?.trim() ?? "",
  runNumber: process.env.GITHUB_RUN_NUMBER?.trim() ?? "",
};

writeFileSync(output, `${JSON.stringify(deploymentInfo, null, 2)}\n`, {
  encoding: "utf8",
});
