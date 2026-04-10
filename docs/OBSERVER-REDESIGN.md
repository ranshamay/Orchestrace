# Observer Redesign: Observe → Verify → Group → Gate → Fix → Learn

## Problem Statement

The current Observer analyzed 110+ session logs and produced 110 open PRs, of which:
- **55** addressed issues already fixed on `main`
- **28** were duplicates of each other (same logical issue, different fingerprints)
- **12** fixed hallucinated problems that never existed in the codebase
- **15** were genuinely useful

The Observer never reads the actual codebase — it only reads session event logs (tool call traces, errors, timing). It sees "rg returned ENOENT" in a log and creates a finding, but can't check whether `command-tools.ts` already handles that case. It also lacks any feedback mechanism to learn from closed/rejected PRs.

## Root Causes

| # | Root Cause | Consequence |
|---|-----------|-------------|
| 1 | No verification against current code before spawning | 55 PRs for already-fixed issues |
| 2 | Fingerprint dedup based on exact `sha256(category+title+description)` — misses semantic equivalence | 28 duplicate PRs |
| 3 | Fix agent receives vague evidence text, hallucinates problems | 12 PRs fixing nonexistent issues |
| 4 | No outcome tracking — never learns from merged/closed PRs | Repeats same mistakes indefinitely |

## New Pipeline

```
Session Logs ──→ LLM Analyze ──→ Hypotheses (not findings)
                                      │
                          ┌────────────┘
                          ▼
                 Stage 2: Verify vs. Code on main
                          │
                          ├── confirmed ──→ Verified Findings
                          └── rejected  ──→ Discarded (logged)
                                                │
                                    ┌───────────┘
                                    ▼
                           Stage 3: Semantic Grouping
                                    │
                                    ▼
                           Canonical Issues (deduplicated)
                                    │
                          ┌─────────┘
                          ▼
                 Stage 4: Spawn Gate
                          │
                          ├── passes  ──→ Approved for Fix
                          └── blocked ──→ Queued (reason logged)
                                              │
                                  ┌───────────┘
                                  ▼
                         Stage 5: Grounded Fix Prompt
                                  │
                                  ▼
                                  PR
                                  │
                          ┌───────┘
                          ▼
                 Stage 6: Outcome Tracking
                          │
                          ├── merged ──→ Record as correct
                          └── closed ──→ Record as false positive
```

---

## Stage 1: Observe (modify existing)

**What changes**: Analysis output produces `hypothesis` status instead of `pending`. Tune down analysis frequency.

### Changes to `daemon.ts`

The `runAnalysisCycle()` method currently calls `registry.register()` which immediately sets `fixStatus: 'pending'`. Instead, findings enter as `hypothesis`.

```
Finding lifecycle:
  hypothesis → verified → grouped → pending → spawned → completed/failed
                 ↓
              rejected (discarded)
```

### Changes to `types.ts`

Add new statuses to `FindingRecord.fixStatus`:

```typescript
fixStatus: 'hypothesis' | 'verified' | 'grouped' | 'pending' | 'spawned' | 'completed' | 'failed' | 'rejected';
```

### Config changes

```typescript
// types.ts - ObserverConfig additions
analysisCooldownMs: 300_000;        // 5min (was 60s)
maxSessionsPerAnalysisBatch: 1;     // 1 (was 3) — less cross-session confusion
```

### Implementation details

- `registry.register()` sets `fixStatus: 'hypothesis'` instead of `'pending'`
- After analysis cycle, instead of calling `spawnPendingFindings()`, call `verifyHypotheses()` (new)
- Keep existing summarizer, analyzer, and prompts unchanged — they produce signal, but signal is now treated as unverified

---

## Stage 2: Verify Against Current Code (new)

**Purpose**: Before a hypothesis becomes a finding, read the actual source files from the working tree and ask the LLM whether the problem exists in the current code.

### New file: `verifier.ts`

```typescript
export interface VerificationResult {
  fingerprint: string;
  verified: boolean;
  evidence: VerifiedEvidence[];  // actual code snippets proving the problem
  reason: string;                // why verified or rejected
}

export interface VerifiedEvidence {
  file: string;        // e.g. "packages/tools/src/command-tools.ts"
  currentCode: string; // the actual code snippet from main
  problem: string;     // what's wrong with it
  suggestedChange: string; // concrete fix
}
```

### Verification flow

For each hypothesis:

1. **Collect file paths** from `finding.relevantFiles`. If empty, use heuristics from `finding.title`/`finding.description` to identify likely files (search the workspace).

2. **Read those files** from the working tree (the main branch). Cap at 5 files, 500 lines each.

3. **Ask the verification LLM**:

```
System: You are a code verification agent. You receive a hypothesis about a
code issue and the actual current source code. Your job is to determine whether
the hypothesized problem ACTUALLY EXISTS in the current code.

Rules:
- If the code already handles the case described in the hypothesis, respond verified=false
- If the hypothesis describes something that doesn't exist in the code at all, respond verified=false
- Only respond verified=true if you can point to specific lines that exhibit the problem
- Include actual code snippets as evidence

User:
## Hypothesis
Title: {title}
Description: {description}
Evidence from session logs: {evidence texts}

## Current Source Code
### {file1}
```
{file contents}
```
### {file2}
...

Respond with JSON:
{
  "verified": true/false,
  "reason": "explanation",
  "evidence": [
    {
      "file": "path/to/file.ts",
      "currentCode": "the problematic code snippet",
      "problem": "what's wrong",
      "suggestedChange": "concrete fix"
    }
  ]
}
```

4. **Update finding status**:
   - `verified=true` → set `fixStatus: 'verified'`, store `VerifiedEvidence[]` on the record
   - `verified=false` → set `fixStatus: 'rejected'`, store `reason` for audit

### Cost control

- Verification uses the same `config.provider`/`config.model` as analysis (observer model, not fix model)
- File reads are local (no LLM cost)
- Each verification call is small (~10k tokens): system prompt + hypothesis + code snippets
- Only hypotheses with `relevantFiles` OR identifiable file references proceed — others are auto-rejected

### Changes to `FindingRecord`

```typescript
interface FindingRecord extends NormalizedObserverFinding {
  // ... existing fields ...
  fixStatus: 'hypothesis' | 'verified' | 'grouped' | 'pending' | 'spawned' | 'completed' | 'failed' | 'rejected';
  
  // New fields
  verifiedEvidence?: VerifiedEvidence[];  // populated after Stage 2
  rejectionReason?: string;               // populated if rejected
  verifiedAt?: string;                    // ISO timestamp
}
```

---

## Stage 3: Semantic Grouping (new)

**Purpose**: Multiple verified findings that address the same underlying issue should be merged into one canonical issue before spawning.

### New file: `grouper.ts`

### Grouping strategy (LLM-based)

Don't use embeddings — instead, use a single LLM call to cluster findings.

When there are N verified findings waiting to be grouped (N ≥ 2):

1. **Collect all verified findings** (`fixStatus: 'verified'`)

2. **Ask the grouping LLM**:

```
System: You are a deduplication agent. Given a list of code issues,
identify which ones are about the SAME underlying problem and should
be merged into a single fix task.

Rules:
- Two findings are duplicates if fixing one would fix the other
- Two findings are related-but-distinct if they touch the same area but require separate fixes
- Return groups: each group becomes one fix task

User:
## Verified Findings

1. [fp: abc123] "validate search_files inputs" — packages/tools/src/command-tools.ts
2. [fp: def456] "harden search_files query validation" — packages/tools/src/command-tools.ts
3. [fp: ghi789] "cap read_files concurrency" — packages/tools/src/fs-tools.ts

Respond with JSON:
{
  "groups": [
    {
      "canonicalTitle": "Best title for the merged issue",
      "canonicalDescription": "Merged description",
      "memberFingerprints": ["abc123", "def456"],
      "reason": "Both address input validation in search_files"
    },
    {
      "canonicalTitle": "Cap read_files concurrency",
      "canonicalDescription": "...",
      "memberFingerprints": ["ghi789"],
      "reason": "Distinct issue in different file"
    }
  ]
}
```

3. **Merge groups**:
   - For each group with >1 member: merge `verifiedEvidence` from all members, pick highest severity, union `relevantFiles`
   - Mark the canonical finding as `fixStatus: 'grouped'` (ready for gate)
   - Mark absorbed findings as `fixStatus: 'rejected'` with `rejectionReason: 'merged into {canonicalFingerprint}'`

4. **Single findings** (group of 1): transition directly from `verified` → `grouped`

### When to run grouping

- After each verification pass, if there are ≥ 2 verified findings
- Also when a single verified finding has been waiting > 1 cycle without grouping (promote it)

### Cost control

- One LLM call per grouping batch (not per finding)
- Only runs when there are new verified findings to group
- Batch size capped at 20 findings per grouping call

---

## Stage 4: Spawn Gate (modified)

**Purpose**: Control what gets spawned. The gate decides which `grouped` findings become `pending` (approved for fix).

### Gate checks (in order)

1. **Existing branch overlap**: Before spawning, check if any open git branches already address this finding. Compare the canonical title against existing remote branch names using substring matching. If a branch named `fix/search-files-*` exists and the finding is about search_files validation, skip spawning.

2. **Severity filter** (`config.minSeverityForAutoFix`): Only auto-spawn for findings at or above the configured severity. Default: `high`. Findings below threshold stay `grouped` and are visible in the UI for manual review/spawn.

3. **Accuracy gate** (`config.minAccuracyForAutoSpawn`): If the observer's historical accuracy (from Stage 6 outcome tracking) drops below the configured threshold, pause auto-spawning entirely. Default: `0.5` (50%). Findings still accumulate and can be manually spawned.

### Config additions

```typescript
// types.ts - ObserverConfig additions
minSeverityForAutoFix: FindingSeverity;   // default: 'high'
minAccuracyForAutoSpawn: number;          // default: 0.5 (50%)
```

### Gate result

- **Pass** → `fixStatus: 'pending'` → proceeds to spawn
- **Blocked (branch overlap)** → stays `grouped`, logged: "Existing branch {name} may address this"
- **Blocked (severity)** → stays `grouped`, visible in UI for manual spawn
- **Blocked (accuracy)** → stays `grouped`, logged: "Auto-spawn paused: accuracy {X}% below threshold"

---

## Stage 5: Grounded Fix Prompt (modify existing)

**Purpose**: The fix prompt sent to the spawned session must include actual code, not just vague evidence text.

### Changes to `spawner.ts` — `buildFixPrompt()`

Current prompt:
```
[Observer Fix] {title}
Category: ... | Severity: ...
## Issue
{description}
## Task
{evidence texts joined}
## Relevant Files
- path/to/file.ts
```

New prompt:
```
[Observer Fix] {canonicalTitle}
Category: ... | Severity: ...

## Issue
{canonicalDescription}

## Verified Evidence
For each verified evidence entry:
### {file}
Current code:
```typescript
{currentCode}
```
Problem: {problem}
Suggested change: {suggestedChange}

## Instructions
- Read each file listed above and confirm the problem still exists before making changes
- If the problem has already been fixed, abort and report "Issue already resolved"
- Make the minimum change needed to fix the identified problem
- Do not refactor surrounding code or add unrelated improvements
- Run validation after changes

(This task was automatically created by the Orchestrace observer agent.
Verification confirmed this issue exists in the current codebase.)
```

### Key change

The fix agent now receives **actual code snippets** showing the problem, not just a description. This dramatically reduces hallucination because the agent can cross-reference the prompt code against what it reads from disk.

### Abort instruction

The prompt explicitly tells the agent to abort if the problem is already fixed. This is the last safety net: even if verification somehow passed a false positive, the fix agent won't make unnecessary changes.

---

## Stage 6: Outcome Tracking (new)

**Purpose**: Track what happens to Observer PRs after they're created. Learn from merged/closed outcomes to improve accuracy over time.

### New file: `outcomes.ts`

### Data model

```typescript
interface ObserverOutcome {
  fingerprint: string;
  fixSessionId: string;
  prUrl: string;
  outcome: 'merged' | 'closed' | 'open';
  detectedAt: string;      // when finding was created
  spawnedAt: string;        // when fix session was spawned
  resolvedAt?: string;      // when PR was merged/closed
}

interface OutcomeStats {
  total: number;
  merged: number;
  closed: number;
  open: number;
  accuracy: number;         // merged / (merged + closed), NaN if no resolved
}
```

### Persistence

File: `.orchestrace/observer/outcomes.json`

### How outcomes are tracked

**Option A: Git-based polling (preferred — no external API dependency)**

Periodically (every analysis cycle), for findings with `fixStatus: 'completed'`:
1. Check if the fix session's branch still exists on remote (`git branch -r --list '*{branchName}*'`)
2. Check if the branch was merged into main (`git branch -r --merged main`)
3. If merged → outcome `merged`
4. If branch deleted and not merged → outcome `closed`
5. If branch still open → outcome `open`

**Option B: PR URL parsing (simpler)**

The daemon already detects `hasPrUrl(outputText)`. Store the PR URL in the finding record. Then periodically check PR status via `gh pr view {url} --json state`.

### Accuracy computation

```
accuracy = merged / (merged + closed)
```

- Ignores `open` PRs (not yet decided)
- Returns `NaN` (treated as 1.0) if no PRs have been resolved yet — benefit of the doubt
- Only considers outcomes from the last 30 days (sliding window) to allow improvement

### Integration with Stage 4 gate

The spawn gate reads `outcomeStats.accuracy` before allowing auto-spawn:
```typescript
if (outcomeStats.accuracy < config.minAccuracyForAutoSpawn) {
  // Block auto-spawn, log reason
  return { blocked: true, reason: `accuracy ${accuracy} below threshold ${threshold}` };
}
```

### Changes to `FindingRecord`

```typescript
interface FindingRecord extends NormalizedObserverFinding {
  // ... existing fields ...
  prUrl?: string;         // captured from fix session output
  outcome?: 'merged' | 'closed' | 'open';
  outcomeCheckedAt?: string;
}
```

---

## Implementation Plan

### Phase 1: Type & Status Migration

**Files**: `types.ts`, `registry.ts`

1. Extend `FindingRecord.fixStatus` with new statuses: `'hypothesis' | 'verified' | 'grouped' | 'rejected'`
2. Add new fields to `FindingRecord`: `verifiedEvidence`, `rejectionReason`, `verifiedAt`, `prUrl`, `outcome`, `outcomeCheckedAt`
3. Add `VerifiedEvidence` interface to types
4. Update `registry.register()` to set initial status as `'hypothesis'` instead of `'pending'`
5. Add `getByStatus(status)` helper to registry
6. Update `parsePersistedFindingRecord()` to handle new fields gracefully (backward compat)
7. Update config defaults: `analysisCooldownMs: 300_000`, `maxSessionsPerAnalysisBatch: 1`
8. Add new config fields: `minSeverityForAutoFix`, `minAccuracyForAutoSpawn`
9. Update `sanitizeObserverConfig()` for new fields
10. Update `DEFAULT_OBSERVER_CONFIG` with new defaults

### Phase 2: Verifier

**Files**: new `verifier.ts`

1. Implement `verifyHypothesis(finding, llm, config, resolveApiKey, workspacePath)` → `VerificationResult`
2. File reading: use `readFile()` from `node:fs/promises` on the working tree files listed in `relevantFiles`
3. Build verification prompt with system + user message containing hypothesis + actual code
4. Parse LLM JSON response into `VerificationResult`
5. Handle edge cases: files don't exist, files too large (truncate at 500 lines), no relevant files (auto-reject)
6. Implement `verifyAllHypotheses(registry, llm, config, resolveApiKey, workspacePath)` batch orchestrator

### Phase 3: Grouper

**Files**: new `grouper.ts`

1. Implement `groupVerifiedFindings(registry, llm, config, resolveApiKey)` → grouping results
2. Build grouping prompt from all `verified` findings
3. Parse LLM response into groups
4. Merge groups: combine evidence, escalate severity, union files
5. Update registry: canonical → `grouped`, absorbed → `rejected`
6. Handle single-finding pass-through (verified → grouped directly)

### Phase 4: Spawn Gate

**Files**: `daemon.ts`, new `gate.ts`

1. Implement `evaluateSpawnGate(finding, config, outcomeStats, workspacePath)` → `{ approved: boolean; reason: string }`
2. Branch overlap check via `git branch -r --list` (shell exec)
3. Severity threshold check
4. Accuracy threshold check
5. Integrate gate into daemon between grouping and spawning

### Phase 5: Grounded Fix Prompt

**Files**: `spawner.ts`

1. Update `buildFixPrompt()` to use `VerifiedEvidence[]` when available
2. Include actual code snippets in prompt
3. Add abort instruction for already-fixed issues
4. Preserve backward compat for findings without verified evidence (legacy `pending` findings)

### Phase 6: Outcome Tracking

**Files**: new `outcomes.ts`, `daemon.ts`

1. Implement `OutcomeTracker` class with persistence to `outcomes.json`
2. Implement `checkOutcomes()` — iterate completed findings, check branch/PR status
3. Implement `computeAccuracy()` with 30-day sliding window
4. Store `prUrl` in finding record when fix session completes with PR
5. Call `checkOutcomes()` at end of each analysis cycle
6. Feed accuracy into spawn gate

### Phase 7: Daemon Orchestration

**Files**: `daemon.ts`

Wire the new stages into `runAnalysisCycle()`:

```typescript
async runAnalysisCycle() {
  // Stage 1: Analyze (existing, produces hypotheses)
  await this.analyzeNewSessions();
  
  // Stage 2: Verify hypotheses against code
  await this.verifyHypotheses();
  
  // Stage 3: Group verified findings
  await this.groupVerifiedFindings();
  
  // Stage 4+5: Gate and spawn
  await this.gateAndSpawnGroupedFindings();
  
  // Stage 6: Check outcomes of completed fixes
  await this.checkOutcomes();
  
  await this.registry.save();
  await this.saveState();
}
```

### Phase 8: Tests

1. `verifier.test.ts` — mock LLM responses, test verified/rejected paths, test file-not-found edge case
2. `grouper.test.ts` — test merging, single pass-through, severity escalation
3. `gate.test.ts` — test severity filter, accuracy gate, branch overlap
4. `outcomes.test.ts` — test accuracy computation, sliding window, persistence
5. Update `daemon.test.ts` — test new cycle flow with hypothesis → verified → grouped → spawned pipeline
6. Update `registry.test.ts` — test new statuses, backward compat for persisted findings

---

## Config Reference (Final)

```typescript
interface ObserverConfig {
  // Existing (unchanged)
  enabled: boolean;
  provider: string;
  model: string;
  logWatcherProvider: string;
  logWatcherModel: string;
  fixProvider: string;
  fixModel: string;
  fixAutoApprove: boolean;
  maxAnalysisPromptChars: number;
  rateLimitCooldownMs: number;
  maxRateLimitBackoffMs: number;
  assessmentCategories: FindingCategory[];
  excludeSessionIds: string[];
  workspaceFilter: string[];
  maxConcurrentFixSessions: number;

  // Modified defaults
  analysisCooldownMs: number;              // default: 300_000 (5min, was 60s)
  maxSessionsPerAnalysisBatch: number;     // default: 1 (was 3)

  // New
  minSeverityForAutoFix: FindingSeverity;  // default: 'high'
  minAccuracyForAutoSpawn: number;         // default: 0.5
}
```

## Finding Status Lifecycle (Final)

```
hypothesis ──→ verified ──→ grouped ──→ pending ──→ spawned ──→ completed
    │              │                       │                        │
    │              │                       │                        ├──→ outcome: merged
    │              │                       │                        └──→ outcome: closed
    │              │                       │
    └──→ rejected  └──→ rejected           └──→ failed
    (not verified)  (merged into group)
```
