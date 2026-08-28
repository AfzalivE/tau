---
name: fix-ci
description: Diagnose and fix failing CI checks on a GitHub pull request or branch through explicit triage and publish gates. Use when the user asks to fix CI, repair failing checks, investigate a broken build, or rerun a flaky GitHub Actions job.
---

# Fix CI

Use `gh` to run this as a gated failure ledger. Advance only after the user clears each gate with a response to the output immediately before it.

## Ledger rules

- Give each failed, timed-out, cancelled, stale, action-required, or otherwise blocking source check a stable ID such as `CI1`. Keep its available provider ID, workflow run and attempt, job, head SHA, and URL.
- Pin all evidence to an exact commit and run attempt. Never combine logs or conclusions from different revisions as if they describe one failure.
- Record whether the check is required, its failing step, the relevant error, classification, root-cause confidence, disposition, priority, local reproduction, commit SHA, verification, and final remote result.
- Track source checks separately from root-cause groups such as `R1`. Group checks only when evidence shows that one indivisible change should fix them. Keep independent causes separate even when they appear in one workflow run.
- Use these dispositions: `fix`, `rerun`, `defer`, and `ignore`. Use `rerun` only when evidence supports a transient infrastructure or flaky-test failure; never use it instead of diagnosis.
- Make one focused commit per accepted root-cause group, including its tests. Map a shared commit to multiple checks only when the user approved that grouping.
- Treat disabling tests, allowing failures, lowering quality gates, changing required checks, or changing branch protection as scope changes that require separate explicit approval.

## Gate 1: Inventory and disposition

1. Identify the repository and target pull request or branch. Read applicable repository instructions and pin the target's live head SHA.
2. Inspect the local branch and working tree without changing them. Record any mismatch with the live target.
3. Fetch all pages of check runs and commit statuses for the exact head SHA. For GitHub Actions, map each failure to its workflow run, attempt, job, and step, then inspect the complete relevant logs and available artifacts. Follow external check links when the available tools support that provider; otherwise record the access limit.
4. Inventory every failed or otherwise blocking source check. Include cancelled, stale, action-required, skipped, and neutral checks when they block completion or clarify another failure. Show pending and running required checks separately so an incomplete run is not mistaken for a failure. Use older attempts only as comparison evidence.
5. Diagnose from the logs and code. Distinguish code, test, CI configuration, flaky test, infrastructure, and external-service failures. Compare with the base or default branch only when needed to establish whether a failure is pre-existing.
6. Present a source-check table with:
   - ledger ID
   - required or optional status
   - workflow, job, and failing step
   - conclusion, run attempt, and head SHA
   - relevant error summary
   - classification, root-cause group, and confidence
   - proposed disposition and priority
   - URL
7. Present a root-cause plan with the affected check IDs, proposed change or rerun, local reproduction and verification commands, expected commit boundary, and material risks.
8. Ask the user to confirm or change every disposition, root-cause grouping, and priority.

Keep this phase read-only. Do not edit, commit, push, cancel, or rerun CI. End the turn when all failures are accounted for and the user has a clear response format.

## Implement the decisions

1. Record the user's decisions. Get a disposition for every root-cause group, or explicit approval to proceed with only a named subset.
2. Refresh the live head and check state before editing. If the head or failure inventory changed materially, update the ledger and return to Gate 1.
3. Check out the target branch and confirm that it tracks the live target. Preserve unrelated working-tree changes. Get an explicit plan before working in a dirty area that overlaps an accepted fix.
4. Implement accepted `fix` groups in priority order:
   - reproduce the failing behavior locally when practical, or record why local reproduction is unavailable
   - fix the root cause with the smallest complete change
   - add or update relevant tests that prove the corrected behavior
   - run focused verification and the CI-equivalent command when practical
   - use the `git-commit` skill to commit only that root-cause group's files or hunks
   - record the full commit SHA and verification result against every mapped check
5. Keep accepted `rerun` operations queued locally. A rerun changes remote state and belongs after Gate 2.
6. If a cause becomes architectural, scope-expanding, uncertain, or inseparable from another group, return it to the user for a new decision.
7. Refresh the remote head and check state without starting CI actions. Route a new head or new failures through Gate 1 before asking to publish.

## Gate 2: Approval to publish

Present the completed ledger with each disposition, root cause, outcome, commit SHA, local verification, and exact queued CI operation. Also show the ordered commit list, the expected push target, and all remaining local changes.

Ask the user to approve the commits and CI operations. State that approval will cause one non-force push if commits exist, any still-applicable approved reruns, and monitoring of the resulting checks. End the turn with all new commits local and no remote CI operation started.

## Publish and verify

1. Start only after Gate 2 approval. Recheck the branch, remote head, commits, working tree, and queued operations. If they differ from the approved report, show the delta and renew Gate 2.
2. If approved commits exist, push them once without force. If the push fails, stop before starting any queued rerun.
3. Verify that every approved commit is reachable from the live target head.
4. Reconcile queued reruns with the post-push state:
   - do not rerun an old attempt when the push started a replacement run
   - run an approved rerun only when it is still applicable to the current head
   - verify the exact run or job before triggering it
5. Monitor the affected and required checks to a terminal result. Record the new run, attempt, check URLs, and conclusions.
6. If a check fails again or a new failure appears, update the ledger and return to Gate 1. Do not start another edit, push, or rerun cycle without renewed approval.
7. Do not merge the pull request, cancel unrelated runs, resolve review threads, or change repository protections unless the user approved that action separately.

Finish when every inventoried failure has an approved disposition and every published fix or rerun has a verified remote result. Report the pushed commits, check links, final CI state, deferred work, and any failures that appeared after publication.
