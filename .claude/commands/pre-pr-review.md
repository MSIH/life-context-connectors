# Pre-PR Review

Multi-persona review of the current branch before the PR opens — catch issues now so the PR opens clean. A `PreToolUse` hook (`.claude/hooks/pre-pr-review-gate.sh`) blocks `gh pr create` until this skill writes the current HEAD SHA to `.claude/.pre-pr-review-done` on an APPROVE / APPROVE-WITH-NITS verdict. For doc-only PRs use `/pre-doc-review` instead.

**Run this proactively, without being asked**, the moment implementation for a change is complete and its own verification passes — it's step 3 of this repo's mandatory workflow (`CLAUDE.md` → "Every Change"), not an optional extra to run on request. Running it does not by itself open a PR — PR creation still needs an explicit ask from the user.

## Inputs
1. `git status --short`; `git rev-parse --abbrev-ref HEAD`
2. `git log --oneline main..HEAD`; `git diff main...HEAD --stat`
3. `git diff main...HEAD` — the full diff
4. Read every changed `.js` / `.json` / hook / doc **in full** — diff context alone is not enough for architecture or security judgments.

If the diff is empty or whitespace-only, say so and stop.

## Step 1 — Triage (required; output first)
```
PR Triage
---------
Branch / Base                  : <cur> / main
Commits / Files / Size         : N / N / XS|S|M|L|XL
Connector(s) touched           : <list, or "repo-wide">
Touches ingest payload shape   : yes|no  (fields sent to /api/v1/ingest or /ingest/batch)
Touches local chat/model calls : yes|no
Touches secrets / env handling : yes|no
New/modified public functions  : yes|no
Touches try/catch or async     : yes|no
Personas engaged               : [Senior, Security, Performance, ConnectorContract, Silent-Failure, TestCoverage]
```

## Step 1.5 — Automated bug hunt (required)
Invoke the built-in `code-review` skill over the branch diff at **high** effort (`max` when Size is L/XL or secrets/payload-shape are touched). Review-only — no `--fix`, no `--comment`. Capture findings under "Automated Bug Hunt", map each to the 1–10 rubric, and feed them into Step 3. "No findings." if clean.

## Step 2 — Persona reviews
Run each engaged persona as a separate, labeled section — independent, no deferring. Each finding: **file:line**, the issue, and a concrete fix (snippet or one-sentence direction). Bucket:
- **Blockers** — must fix before PR opens (sev 9–10).
- **Should-fix `[sev N/10]`** — open the PR, fix before merge. Rubric: 8–9 behavior bug / security hole; 5–7 correctness / maintainability; 3–4 style; 1–2 preference. Sort high→low.
- **Nits** — optional (sev 0–2).

- **Senior Node / ESM** — `async`/`await` correctness; no floating promises (`await` or explicit discard); guard clauses on inputs (esp. hook/stdin/env input from outside the process); resource cleanup; ESM-only (`import`, no `require`); no blocking sync I/O in a hot path (a one-shot startup read like an `.env` loader is fine); matches the nearest existing connector's density/idiom; no `var`, magic numbers, dead/commented code.
- **Security / secrets** — no hardcoded secrets/keys/tokens (env only); no committed `.env` / `node_modules` / spool-or-cursor state files; `x-api-key` only ever read from env and only ever sent as a header, never logged; no secret value appears in an error message or log line.
- **Performance** — no `await` in a tight loop where a batch call (`/ingest/batch`) would do; no unbounded in-memory growth (a long-running watch/poll connector must not accumulate everything it's ever seen); local model/network calls aren't repeated when one call would do.
- **Connector Contract Compliance** — payload matches `docs/04-connector-contract.md` §3 (required fields present, `content_hash` format, `entity_hints` shape); `source_id` is deterministic from source data, never a random/runtime UUID; no embedding/vector computation happens in connector code; failure posture followed (spool-on-failure, never buffer unbounded, never require the server to be up to *observe* non-ephemeral source data). See `.claude/rules/connector-conventions.md`.
- **Silent-Failure / Error-Handling** — no empty `catch {}`; no catch-and-swallow where the caller can't recover; generic `catch (err)` carries a one-line justification or a specific type; a push-style connector (hook) must exit 0 after logging, never crash the invoking process; no fire-and-forget promise that can reject unobserved.
- **Test Coverage** — for each new/changed public function, is there coverage (a `node:test` file, or at minimum a documented manual/mock-server verification)? Rate the gap 1–10 (10 = must add before merge). List the test names/checks you'd add.

## Step 3 — Reconciliation & verdict
Merge Automated-Bug-Hunt findings with persona findings (dedupe same file/line). Then:
```
Overall Verdict  : APPROVE | APPROVE-WITH-NITS | CHANGES-REQUESTED | BLOCK
Blocker count    : N
Should-fix count : N (9-10:N 7-8:N 5-6:N 3-4:N 1-2:N)
Nit count        : N
Top 3 to fix before PR (by severity): 1… 2… 3…
PR title         : <conventional commit, ≤70 chars>
PR body skeleton : first line `Closes #<n>`; then Summary / Changes / Verification / Test plan
```
Rubric: any Blocker → BLOCK; no Blockers but ≥1 Should-fix ≥8 → CHANGES-REQUESTED; findings but none ≥8 → APPROVE-WITH-NITS; nothing above Nit → APPROVE.

## Verification gate (required before any APPROVE)
There is no shared server/build to smoke-test — verify each touched connector on its own terms: run it against local mock servers standing in for the LifeContext ingest endpoint and any chat/model endpoint it calls (see `devsession/index.js`'s development history for the pattern), and confirm the documented failure paths (server unreachable → spool; malformed/missing required input → logged and skipped, not crashed) actually behave as documented. If a live LifeContext server or model endpoint is unavailable and the mock-server path wasn't exercised either, say so and do NOT approve on assumption. For doc-only changes with no code touched, verify commands/links instead and note no code was changed.

## Step 4 — Auto-fix (apply broadly)
Apply all Nits and all deterministic Should-fix items (single correct edit; naming, missing guard, empty-catch→log, missing input validation, test stubs) without per-item prompting. **Hold for a single go/no-go**: structural refactors (e.g. changing the spool file format), public-function signature changes, behavior changes. Apply in batches; after each batch re-run the connector's own verification; on red, revert that batch (`git restore .` + `git clean -fd` for scaffolded files) and re-classify. Commit batches separately. Re-run and re-verdict before proceeding.

## Clear the gate
On `APPROVE` / `APPROVE-WITH-NITS` **only**:
```bash
git rev-parse HEAD > "$CLAUDE_PROJECT_DIR/.claude/.pre-pr-review-done"
```
Do NOT write it on `CHANGES-REQUESTED` / `BLOCK` — fix the Blockers, re-run, and it clears. If the user explicitly says "open it anyway", confirm once, then write the marker.

## Step 5 — Request bot review
After the PR is created, request a Copilot review (`--reviewer @copilot` at create, or `gh pr edit <n> --add-reviewer @copilot`). Other bots (Greptile/CodeRabbit) auto-trigger if installed. Bot reviews are comment-only — they never block merge. Surface `gh` errors verbatim; don't retry on org/license errors.

## Step 6 — Monitor & resolve reviews (second-level)
Poll up to ~10 min for reviews (use the Monitor tool, not a sleep loop). When they arrive, fetch all three endpoints — formal reviews, inline thread comments, PR conversation comments — and triage each: **Accept** (fix; ≥7 before merge), **Defer** (valid, out of scope → follow-up issue, link it), **Dismiss** (invalid / violates a repo convention → cite the rule). Persona findings outrank bot findings on repo conventions (e.g. a bot suggesting a committed `.env` or a random `source_id` is wrong here). Apply mechanical Accepts, re-verify, push, resolve every thread. Hard cap: one Copilot re-request per invocation.

## Step 7 — Post-merge cleanup (automatic, no prompt)
Once the PR is MERGED (gh is source of truth): from the primary checkout `git checkout main && git pull origin main`; `git worktree remove <path> --force` (guard: state==MERGED, no uncommitted **tracked** changes); `git worktree prune`; `git branch -D <branch>`; `git fetch origin --prune`. Never remove a worktree whose PR isn't merged.

## Rules
- Do not open the PR yourself in this skill — output + gate-clear only.
- Persona findings outrank both the bug-hunt and bot reviews on MSIH/repo conventions.
- Don't invent findings. "No findings." when a persona is clean.
- Severity tag required on every Should-fix.
