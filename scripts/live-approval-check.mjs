/**
 * Full-cycle live check: webhook -> awaiting-approval -> approve -> draft pull request.
 *
 *   node scripts/live-approval-check.mjs
 *
 * Approval must happen in the same process that ran the turn, because the harness keeps
 * session state in memory. CREATES A REAL BRANCH AND DRAFT PR on the target repo.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetRepo = process.env.LIVE_REPO ?? "the-ashish2005/squasher-live-test";
const issueNumber = Number(process.env.LIVE_ISSUE ?? "1");

for (const line of (await readFile(join(repoRoot, ".env"), "utf8")).split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const dataDir = await mkdtemp(join(tmpdir(), "squasher-approve-"));
const staticDir = await mkdtemp(join(tmpdir(), "squasher-approve-static-"));
await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
process.env.DATA_DIR = dataDir;
process.env.STATIC_DIR = staticDir;

const { createSquasherServer } = await import(join(repoRoot, "apps/server/dist/server.js"));
const [owner, repoName] = targetRepo.split("/");

const gh = async (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      ...(init.body ? { "Content-Type": "application/json" } : {})
    }
  });

const issue = await (await gh(`/repos/${targetRepo}/issues/${issueNumber}`)).json();
const deliveryId = `approve-${randomUUID()}`;
const payload = JSON.stringify({
  action: "labeled",
  label: { name: process.env.SQUASHER_TRIGGER_LABEL ?? process.env.BYTER_TRIGGER_LABEL ?? "squasher:run" },
  issue: {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: issue.html_url,
    labels: (issue.labels ?? []).map((entry) => ({ name: entry.name }))
  },
  repository: {
    name: repoName,
    full_name: targetRepo,
    default_branch: "main",
    owner: { login: owner }
  }
});

const server = createSquasherServer();
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const intake = await fetch(`${baseUrl}/api/github/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET).update(payload).digest("hex")}`
    },
    body: payload
  });
  console.log(`[1] webhook: HTTP ${intake.status}`);

  let latest;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 3000));
    latest = await fetch(`${baseUrl}/api/runs/latest`).then((r) => r.json());
    if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) break;
  }
  console.log(`[2] run reached: run=${latest?.run?.status} trueForge=${latest?.trueForge?.status}`);

  if (latest?.run?.status !== "awaiting-approval") {
    console.error("[!] did not reach awaiting-approval; aborting before approval");
    console.error("    error:", latest?.trueForge?.error);
    process.exit(1);
  }

  const runId = latest.run.id;
  const patchHash = latest.trueForge.result.candidatePatch.hash;
  console.log(`[3] approving runId=${runId}`);

  const approval = await fetch(`${baseUrl}/api/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.APPROVAL_TOKEN}` },
    body: JSON.stringify({ actionId: "approve-pr", runId, patchHash })
  });
  const receipt = await approval.json();
  console.log(`[4] approval: HTTP ${approval.status}`);
  console.log(`    resultStatus: ${receipt.resultStatus}`);
  console.log(`    message:      ${receipt.message}`);
  console.log(`    pullRequest:  ${JSON.stringify(receipt.pullRequest)}`);
  if (receipt.error) console.log(`    error:        ${receipt.error}`);

  const after = await fetch(`${baseUrl}/api/runs/latest`).then((r) => r.json());
  console.log(`[5] final run status: ${after?.run?.status} | trueForge: ${after?.trueForge?.status}`);

  // Verify against GitHub itself rather than trusting the receipt.
  const branch = latest.trueForge.result.candidatePatch.branchName;
  const branchResp = await gh(`/repos/${targetRepo}/branches/${branch}`);
  console.log(`[6] branch ${branch}: HTTP ${branchResp.status}`);

  const prs = await (await gh(`/repos/${targetRepo}/pulls?state=all`)).json();
  console.log(`[7] pull requests on repo: ${prs.length}`);
  for (const pr of prs) {
    console.log(`    #${pr.number} draft=${pr.draft} state=${pr.state} head=${pr.head.ref} -> ${pr.base.ref}`);
    console.log(`       ${pr.html_url}`);
    const files = await (await gh(`/repos/${targetRepo}/pulls/${pr.number}/files`)).json();
    for (const f of files) console.log(`       changed: ${f.filename} +${f.additions}/-${f.deletions}`);
  }

  const labels = (await (await gh(`/repos/${targetRepo}/issues/${issueNumber}`)).json()).labels.map((l) => l.name);
  console.log(`[8] issue labels now: ${JSON.stringify(labels)}`);
} finally {
  await new Promise((closed) => server.close(closed));
}
process.exit(0);
