/**
 * Drives one real Byter run against a live GitHub issue, using the real DeepSeek
 * model and a real E2B sandbox. Parks at awaiting-approval; never approves.
 *
 *   node scripts/live-run.mjs [runLabel]
 *
 * Reads .env from the repo root. Each run gets a fresh DATA_DIR so the duplicate
 * trigger guards (which are DATA_DIR scoped) do not suppress repeated runs.
 */
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runLabel = process.argv[2] ?? "1";
const targetRepo = process.env.LIVE_REPO ?? "the-ashish2005/squasher-live-test";
const issueNumber = Number(process.env.LIVE_ISSUE ?? "1");
const perRunTimeoutMs = Number(process.env.LIVE_TIMEOUT_MS ?? String(12 * 60_000));

for (const line of (await readFile(join(repoRoot, ".env"), "utf8")).split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const dataDir = await mkdtemp(join(tmpdir(), `byter-live-${runLabel}-`));
const staticDir = await mkdtemp(join(tmpdir(), "byter-live-static-"));
await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
process.env.DATA_DIR = dataDir;
process.env.STATIC_DIR = staticDir;

const { createByterServer } = await import(join(repoRoot, "apps/server/dist/server.js"));

const [owner, repoName] = targetRepo.split("/");
const issue = await fetchIssue();
const deliveryId = `live-${runLabel}-${randomUUID()}`;
const payload = JSON.stringify({
  action: "labeled",
  label: { name: process.env.BYTER_TRIGGER_LABEL ?? "byter:run" },
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
    default_branch: process.env.LIVE_BASE_BRANCH ?? "main",
    owner: { login: owner }
  }
});

const server = createByterServer();
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const startedAt = Date.now();
let outcome = "unknown";
let latest;

try {
  const response = await fetch(`${baseUrl}/api/github/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET).update(payload).digest("hex")}`
    },
    body: payload
  });
  const intake = await response.json();
  console.log(`[run ${runLabel}] webhook HTTP ${response.status} run=${intake?.run?.status} trueForge=${intake?.trueForge?.status}`);
  if (intake?.trueForge?.reason) console.log(`[run ${runLabel}] reason: ${intake.trueForge.reason}`);
  if (intake?.ignored) {
    outcome = "ignored";
    throw new Error(`webhook ignored: ${JSON.stringify(intake)}`);
  }

  while (Date.now() - startedAt < perRunTimeoutMs) {
    await new Promise((wait) => setTimeout(wait, 3000));
    try {
      latest = await fetch(`${baseUrl}/api/runs/latest`).then((result) => result.json());
    } catch {
      continue;
    }
    const status = latest?.trueForge?.status;
    if (status === "paused" || status === "completed" || status === "failed") {
      outcome = status;
      break;
    }
  }
  if (outcome === "unknown") outcome = "timeout";
} catch (error) {
  console.error(`[run ${runLabel}] driver error:`, error.message);
} finally {
  await new Promise((closed) => server.close(closed));
}

const events = await readHarnessEvents(dataDir);
const guardEvents = events.filter((entry) => entry.event?.type === "byter.structured_output.guard");
const toolCalls = events.flatMap((entry) =>
  (entry.event?.toolCalls ?? []).map((call) => call.function?.name).filter(Boolean)
);
const turnErrors = events
  .filter((entry) => entry.event?.type === "turn.done" && entry.event?.state?.status === "error")
  .map((entry) => entry.event.state.message);

const summary = {
  run: runLabel,
  outcome,
  durationSec: Math.round((Date.now() - startedAt) / 1000),
  runStatus: latest?.run?.status ?? null,
  trueForgeStatus: latest?.trueForge?.status ?? null,
  trueForgeError: latest?.trueForge?.error ?? null,
  resultStatus: latest?.trueForge?.result?.status ?? null,
  attempts: latest?.trueForge?.result?.proof?.attempts ?? null,
  hasCandidatePatch: Boolean(latest?.trueForge?.result?.candidatePatch),
  toolCallSequence: toolCalls,
  guardRetries: guardEvents.map((entry) => ({
    tool: entry.event.toolName,
    attempt: entry.event.attempt,
    outcome: entry.event.outcome,
    problem: entry.event.problem
  })),
  turnErrors,
  dataDir
};

await mkdir(join(repoRoot, ".live-runs"), { recursive: true });
await writeFile(join(repoRoot, ".live-runs", `run-${runLabel}.json`), JSON.stringify({ summary, events }, null, 2), "utf8");

console.log(`[run ${runLabel}] SUMMARY ${JSON.stringify(summary, null, 2)}`);
process.exit(0);

async function fetchIssue() {
  const response = await fetch(`https://api.github.com/repos/${targetRepo}/issues/${issueNumber}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (!response.ok) throw new Error(`Could not read issue: HTTP ${response.status}`);
  return response.json();
}

async function readHarnessEvents(dir) {
  try {
    const contents = await readFile(join(dir, "harness-events.jsonl"), "utf8");
    return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
