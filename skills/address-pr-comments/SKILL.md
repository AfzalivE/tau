---
name: address-pr-comments
description: Address feedback on an existing GitHub pull request through explicit disposition and approval gates. Use when the user wants to handle PR review comments.
---

# Address PR Comments

Use `gh` to run this as a gated ledger. Advance only after the user clears each gate with a response to the output immediately before it.

## Ledger rules

- Give each feedback-bearing source comment a stable ID such as `C1` and keep its GitHub ID and URL.
- Treat requested changes, suggestions, questions, concerns, and corrections as feedback. Exclude approvals, praise, and status noise unless they also ask for action.
- Record the author, location, status, requested outcome, user disposition, priority, commit SHA, reply draft, and posted reply URL.
- Use these dispositions: `implement`, `reply only`, `defer`, and `ignore`. `ignore` means no code change; it still gets a reply with the agreed rationale.
- Make one focused commit per accepted change, including its tests. Split one comment into multiple ledger items when it requests independent changes, and link those items back to the same source comment.
- Never combine independent items. If one indivisible fix necessarily covers multiple source comments, ask first and record the approved shared SHA against each comment.

## Gate 1: Inventory and disposition

1. Identify the repository and PR. Read applicable repository instructions and inspect the live PR context.
2. Fetch all pages of:
   - inline review threads and their replies, including resolved and outdated state
   - review-body feedback
   - PR conversation comments
3. Select every feedback-bearing source comment. Include resolved, outdated, and previously answered feedback, and record its current state rather than omitting it.
4. Present each source comment once in a table with:
   - ledger ID
   - author
   - file and line, review body, or conversation
   - faithful feedback summary, with exact wording where it affects meaning
   - current status
   - proposed disposition and priority
   - URL
5. Call out duplicates, dependencies, conflicts, and comments that could share one root cause.
6. Ask the user to confirm or change each disposition and priority.

Keep this phase read-only. End the turn when every feedback-bearing source comment appears in the inventory and the user has a clear format for responding.

## Implement the decisions

1. Record the user's decisions. Get a disposition for every item, or explicit approval to proceed with only a named subset.
2. Refresh the PR feedback before editing. If new feedback exists, add it to the inventory and return to Gate 1.
3. Check out the PR head branch and confirm it matches the live PR. Inspect the working tree and preserve unrelated changes. Get an explicit plan before working in a dirty area that overlaps an accepted item.
4. Implement `implement` items in the user's priority order:
   - make the smallest complete change that addresses the item
   - include relevant tests in the same commit
   - run focused verification
   - use the `git-commit` skill to commit only that item's files or hunks with a specific message
   - record the full commit SHA and verification result in the ledger
5. If an item becomes architectural, scope-expanding, uncertain, or inseparable from another item, return it to the user for a new decision.
6. Draft a concise reply for every source comment. Promise deferred work only when the user approved a concrete follow-up.
7. Refresh feedback again. Route new comments through Gate 1 before asking to push.

## Gate 2: Approval to publish

Present the completed ledger with each disposition, outcome, commit SHA, verification result, and exact draft reply. Also show the ordered commit list and any remaining local changes.

Ask the user to approve the commits and replies. State that approval will cause one push, verification of the live PR head, and then posting of the shown replies. End the turn with all new commits still local and no new PR replies posted.

## Push and reply

1. Start only after Gate 2 approval. Recheck the branch, commits, working tree, and reply drafts. If they differ from the approved report, show the delta and renew Gate 2.
2. Push the approved commits once. If the push fails, stop before posting replies.
3. Verify that every recorded change SHA is reachable from the live PR head. Use the verified remote SHA if history changed; renew Gate 2 when the mapping is uncertain.
4. Reply to every source comment:
   - reply in the original inline thread when GitHub supports it
   - for review-body or conversation feedback without a replyable thread, post an individual PR conversation reply that links to the source comment
   - for implemented feedback, state the outcome and include every mapped commit SHA as plain text so GitHub autolinks it
   - for feedback without a code change, state the agreed disposition and brief rationale
5. Keep reactions and thread-resolution state unchanged unless Gate 2 explicitly included those actions.
6. Verify each posted reply and record its URL. Avoid duplicate replies when only part of the posting sequence fails.

Finish when each inventory item has an approved disposition, each implemented item maps to a pushed PR commit, and each source comment has a verified reply URL. Report the pushed commits, reply links, deferred work, and any feedback that arrived after the final refresh.
