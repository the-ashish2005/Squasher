import { describe, expect, it } from "vitest";
import { createGitHubMcpTools, repositoryEvidenceProblem } from "../src/index.js";

/**
 * A live run on drkrillo/good-first-issues#164 reported "sort by repository name" as
 * already implemented because the owner's comment said sorting worked "by any column,
 * including Created, Updated and Repo". The page's Repo column was not sortable. These pin
 * the rule that fixed it: a comment is a claim, and only the repository is evidence.
 */

/** Mirrors the real page: three sortable columns, and a Repo column that is not. */
const indexHtml = [
  "const COLUMNS = [",
  '  { key: "repo",       label: "Repo" },',
  '  { key: "title",      label: "Title" },',
  '  { key: "comments",   label: "Comments", sortable: true, numeric: true, align: "center" },',
  '  { key: "created_at", label: "Created",  sortable: true },',
  '  { key: "updated_at", label: "Updated",  sortable: true },',
  "];",
  "function handleSort(column) {",
  "  if (sortColumn === column) {",
  '    sortDir = sortDir === "desc" ? "asc" : "desc";',
  "  }",
  "}"
].join("\n");

const repository: Record<string, string> = { "index.html": indexHtml };
const readFile = async (path: string) => repository[path];

/** What the owner's comment asserts, quoted as if it were code. It is not in the file. */
const claimedRepoSorting = '{ key: "repo",       label: "Repo", sortable: true }';

const sortingRequirements = {
  comments: {
    requirement: "Sort by comment count",
    verdict: "already-implemented",
    evidence: "COLUMNS marks comments sortable.",
    codeEvidence: [{ path: "index.html", excerpt: '{ key: "comments",   label: "Comments", sortable: true' }]
  },
  created: {
    requirement: "Sort by created date",
    verdict: "already-implemented",
    evidence: "COLUMNS marks created_at sortable.",
    codeEvidence: [{ path: "index.html", excerpt: '{ key: "created_at", label: "Created",  sortable: true }' }]
  },
  updated: {
    requirement: "Sort by updated date",
    verdict: "already-implemented",
    evidence: "COLUMNS marks updated_at sortable.",
    codeEvidence: [{ path: "index.html", excerpt: '{ key: "updated_at", label: "Updated",  sortable: true }' }]
  }
};

describe("discussion claims against repository evidence", () => {
  it("does not accept a maintainer's claim as proof when the repository lacks the capability", async () => {
    const problem = await repositoryEvidenceProblem(
      {
        requirements: [
          {
            requirement: "Sort by repository name",
            verdict: "already-implemented",
            evidence: "The owner says sorting works on any column, including Repo.",
            codeEvidence: [{ path: "index.html", excerpt: claimedRepoSorting }]
          }
        ]
      },
      readFile,
      []
    );

    expect(problem).toContain('requirement "Sort by repository name"');
    expect(problem).toContain("does not occur in index.html");
    expect(problem).toContain("is a claim, not repository evidence");
    expect(problem).toContain("mark the requirement missing");
  });

  it("confirms a claim the repository really implements", async () => {
    const problem = await repositoryEvidenceProblem(
      {
        requirements: [sortingRequirements.comments],
        discussionClaims: [
          {
            claim: "@drkrillo (OWNER): comments can be sorted",
            verdict: "confirmed",
            evidence: "COLUMNS marks comments sortable.",
            codeEvidence: sortingRequirements.comments.codeEvidence
          }
        ]
      },
      readFile,
      []
    );

    expect(problem).toBeUndefined();
  });

  it("evaluates a broad claim per capability and keeps the missing one missing", async () => {
    const decomposed = {
      requirements: [
        sortingRequirements.comments,
        sortingRequirements.created,
        sortingRequirements.updated,
        {
          requirement: "Sort by repository name",
          verdict: "missing",
          evidence: 'COLUMNS declares { key: "repo", label: "Repo" } with no sortable flag, so the Repo header renders no sort button.'
        }
      ],
      discussionClaims: [
        {
          claim: "@drkrillo (OWNER): sorting by any column, including Created, Updated and Repo, is already in the page",
          verdict: "partly-confirmed",
          evidence: "Comments, Created and Updated are sortable; Repo is not.",
          codeEvidence: sortingRequirements.created.codeEvidence
        }
      ]
    };

    expect(await repositoryEvidenceProblem(decomposed, readFile, [])).toBeUndefined();

    // The same broad claim, taken at its word for the Repo column, is refused.
    const lumped = {
      requirements: [
        ...decomposed.requirements.slice(0, 3),
        { ...decomposed.requirements[3]!, verdict: "already-implemented", codeEvidence: [{ path: "index.html", excerpt: claimedRepoSorting }] }
      ]
    };
    expect(await repositoryEvidenceProblem(lumped, readFile, [])).toContain('"Sort by repository name"');
  });

  it("accepts a command as behavioural evidence only when it actually ran", async () => {
    const result = {
      requirements: [
        {
          requirement: "Sort by created date",
          verdict: "already-implemented",
          evidence: "Clicking Created reorders rows by date in the DOM harness.",
          executedCommand: "node sort-check.mjs --column created_at"
        }
      ]
    };

    expect(await repositoryEvidenceProblem(result, readFile, [])).toContain("was not run in this session's sandbox");
    expect(await repositoryEvidenceProblem(result, readFile, ["cd /tmp/repo && node sort-check.mjs --column created_at"])).toBeUndefined();
  });

  it("refuses evidence from a file that does not exist", async () => {
    const problem = await repositoryEvidenceProblem(
      { requirements: [{ ...sortingRequirements.created, codeEvidence: [{ path: "src/sort.js", excerpt: "export function sortByCreated" }] }] },
      readFile,
      []
    );

    expect(problem).toContain("cites src/sort.js, which does not exist");
  });
});

describe("the result contract for claims and ownership", () => {
  const tools = createGitHubMcpTools({ client: {} as never });
  const notActionable = {
    kind: "squasher.result",
    status: "not-actionable",
    summary: "The owner split the remaining work into other issues.",
    proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/0" },
    candidatePatch: null
  };
  const implemented = {
    kind: "squasher.result",
    status: "implemented-improvement",
    summary: "Added a responsive layout for phones and tablets to the issue list.",
    proof: {
      before: "The layout test failed 3/3 against the old stylesheet.",
      after: "It passed 3/3 after the change.",
      regressions: "The existing 83 tests still pass.",
      attempts: "3/3 matching executions"
    },
    candidatePatch: { title: "Responsive issue list", body: "Adds tablet and phone breakpoints.", files: [{ path: "index.html", content: "<style></style>\n" }] }
  };
  const submit = (args: Record<string, unknown>) => tools.callTool({ name: "submit_squasher_result", arguments: args });

  it("refuses an already-implemented requirement backed only by what a comment said", async () => {
    await expect(
      submit({
        ...notActionable,
        requirements: [{ requirement: "Sort by repository name", verdict: "already-implemented", evidence: "The owner says Repo sorting exists." }]
      })
    ).rejects.toThrow("without repository evidence");
  });

  it("refuses to build work the discussion reserved for someone else", async () => {
    await expect(
      submit({
        ...implemented,
        requirements: [
          {
            requirement: "Improve the mobile/responsive layout",
            verdict: "pass",
            evidence: "The layout test passes at 390px.",
            ownership: { status: "offered", by: "@tiruveedhula-charuhasini", basis: "Feel free to open an issue for that one and I will assign it to you" }
          }
        ]
      })
    ).rejects.toThrow("must not be implemented in this run");
  });

  it("keeps reserved work's technical state separate from its ownership", async () => {
    const result = await submit({
      ...notActionable,
      requirements: [
        {
          requirement: "Issue cards and language badges",
          verdict: "missing",
          evidence: "renderTable still renders table rows; no card markup exists.",
          ownership: { status: "reserved", by: "@drkrillo", basis: "The rest I am going to split into separate issues myself" }
        }
      ]
    });

    expect(result.content[0]?.text).toContain('"accepted":true');
  });

  it("does not let a proven change leave an unowned requirement missing", async () => {
    await expect(
      submit({
        ...implemented,
        requirements: [
          { requirement: "Tablet breakpoint", verdict: "pass", evidence: "The layout test passes at 800px." },
          { requirement: "Sort by repository name", verdict: "missing", evidence: "Repo column has no sortable flag." }
        ]
      })
    ).rejects.toThrow("is still missing");
  });

  it("keeps a contradicted claim with what the code shows, and refuses a confirmation without evidence", async () => {
    const kept = await submit({
      ...notActionable,
      discussionClaims: [
        {
          claim: "@drkrillo (OWNER): sorting by Repo already exists",
          verdict: "contradicted",
          evidence: 'COLUMNS declares { key: "repo", label: "Repo" } with no sortable flag.'
        }
      ]
    });
    expect(kept.content[0]?.text).toContain('"accepted":true');

    await expect(
      submit({
        ...notActionable,
        discussionClaims: [{ claim: "@drkrillo (OWNER): sorting by Repo already exists", verdict: "confirmed", evidence: "The owner said so." }]
      })
    ).rejects.toThrow("without repository evidence");
  });
});
