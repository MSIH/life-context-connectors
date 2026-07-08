#!/usr/bin/env bash
# Acceptance tests for cloud-issue-gate.sh + draft-issue-gate.sh method-awareness.
# Mirrored from msih/life-context (issue #13) — the gate scripts are unchanged, so the
# same tests apply verbatim.
set -u
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
GATE=$REPO/.claude/hooks/cloud-issue-gate.sh
DIG=$REPO/.claude/hooks/draft-issue-gate.sh
WTG=$REPO/.claude/hooks/worktree-edit-gate.sh
FAKE=$(mktemp -d)            # fake project dir with NO marker
mkdir -p "$FAKE/.claude"
PASS=0; FAIL=0

check() { # name expect(allow|deny) actual_out actual_rc
  local name=$1 expect=$2 out=$3 rc=$4 verdict
  if [[ $rc -ne 0 ]]; then verdict="error"
  elif echo "$out" | grep -qE '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; then verdict="deny"
  else verdict="allow"; fi
  if [[ "$verdict" == "$expect" ]]; then echo "PASS: $name"; PASS=$((PASS+1))
  else echo "FAIL: $name — expected $expect, got $verdict (rc=$rc) out=$out"; FAIL=$((FAIL+1)); fi
}

run_gate() { # env_remote project_dir file_path
  CLAUDE_CODE_REMOTE=$1 CLAUDE_PROJECT_DIR=$2 bash "$GATE" <<<"{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$3\"}}"
}

# --- cloud-issue-gate ---
out=$(run_gate true "$FAKE" "$FAKE/devsession-claude/index.js"); check "cloud, repo .js, no marker -> deny" deny "$out" $?
out=$(run_gate true "$FAKE" "$FAKE/README.md"); check "cloud, repo doc, no marker -> deny" deny "$out" $?
out=$(run_gate true "$FAKE" "$FAKE/.claude/hooks/x.sh"); check "cloud, .claude tooling, no marker -> deny" deny "$out" $?
out=$(run_gate true "$FAKE" "$FAKE/.claude/.cloud-issue-done"); check "cloud, marker file itself -> allow" allow "$out" $?
out=$(run_gate true "$FAKE" "$FAKE/.claude/settings.local.json"); check "cloud, settings.local.json -> allow" allow "$out" $?
out=$(run_gate true "$FAKE" "/tmp/elsewhere/scratch.md"); check "cloud, outside project dir -> allow" allow "$out" $?
out=$(run_gate false "$FAKE" "$FAKE/devsession-claude/index.js"); check "non-cloud -> allow" allow "$out" $?

echo junk > "$FAKE/.claude/.cloud-issue-done"
out=$(run_gate true "$FAKE" "$FAKE/devsession-claude/index.js"); check "cloud, junk marker -> deny" deny "$out" $?
echo 13 > "$FAKE/.claude/.cloud-issue-done"
out=$(run_gate true "$FAKE" "$FAKE/devsession-claude/index.js"); check "cloud, valid marker -> allow" allow "$out" $?
out=$(CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR=$FAKE bash "$GATE" <<<'{"tool_name":"Edit","tool_input":{"file_path":"relative/path.js"}}')
check "cloud, relative path, valid marker -> allow" allow "$out" $?
rm -f "$FAKE/.claude/.cloud-issue-done"
out=$(CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR=$FAKE bash "$GATE" <<<'{"tool_name":"Edit","tool_input":{"file_path":"relative/path.js"}}')
check "cloud, relative path, no marker -> deny" deny "$out" $?
out=$(CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR=$FAKE bash "$GATE" <<<'{"tool_name":"Edit","tool_input":{}}')
check "cloud, no file_path in input -> allow (no-op)" allow "$out" $?

# --- worktree-edit-gate cloud awareness ---
out=$(CLAUDE_CODE_REMOTE=true bash "$WTG" <<<'{"tool_name":"Edit","tool_input":{"file_path":"/x/devsession-claude/index.js"}}')
check "worktree-gate: cloud .js edit -> allow (stands down)" allow "$out" $?
out=$(CLAUDE_CODE_REMOTE=false bash "$WTG" <<<'{"tool_name":"Edit","tool_input":{"file_path":"/x/devsession-claude/index.js"}}')
check "worktree-gate: local .js outside worktree -> deny (regression)" deny "$out" $?

# --- draft-issue-gate (run against FAKE dir: no draft-issue marker) ---
out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"mcp__github__issue_write","tool_input":{"method":"update","issue_number":12}}')
check "issue_write method=update, no marker -> allow" allow "$out" $?
out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"mcp__github__issue_write","tool_input":{"title":"x"}}')
check "issue_write method missing, no marker -> deny (fail-closed)" deny "$out" $?
if command -v jq >/dev/null 2>&1; then
  out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"mcp__github__issue_write","tool_input":{"body":"text saying \"method\":\"create\" inline","method":"update","issue_number":12}}')
  check "issue_write update w/ create-lookalike body -> allow (jq parse)" allow "$out" $?
fi
out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"mcp__github__issue_write","tool_input":{"method":"create","title":"x"}}')
check "issue_write method=create, no marker -> deny" deny "$out" $?
out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"Bash","tool_input":{"command":"gh issue create -t x"}}')
check "gh issue create, no marker -> deny (regression)" deny "$out" $?
date -u +%Y-%m-%dT%H:%M:%SZ > "$FAKE/.claude/.draft-issue-done"
out=$(CLAUDE_PROJECT_DIR=$FAKE bash "$DIG" <<<'{"tool_name":"mcp__github__issue_write","tool_input":{"method":"create","title":"x"}}')
check "issue_write method=create, fresh marker -> allow (regression)" allow "$out" $?

rm -rf "$FAKE"
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
