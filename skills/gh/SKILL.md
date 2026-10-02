---
name: gh
description: "GitHub CLI for issues, PRs, Actions, search, and raw API calls. Use when interacting with GitHub repositories, pull requests, issues, or workflows."
---

# GitHub CLI (`gh`)

Verified against `gh` 2.100.0. Check `gh --version` and command `--help` when flags differ.

## Safety

- Get explicit user approval before pushing or creating a PR.
- Treat merges, reviews, comments, edits, and workflow reruns as remote changes. Run them only within the approved task.
- `gh pr create --dry-run` can still push commits. Use `--head` to skip automatic pushing and forking.
- Use `--body-file` for multiline Markdown to avoid shell quoting errors.

## Repo Targeting

Most commands auto-detect repo from cwd. Override with `-R OWNER/REPO`.
`gh api` uses `GH_REPO=OWNER/REPO` instead of `-R`, or an explicit repo path.
Placeholders `{owner}`, `{repo}`, `{branch}` work in `gh api` endpoints. Quote endpoints that contain placeholders or query strings.

## Quick Reference

| Task            | Command                                |
| --------------- | -------------------------------------- |
| List open PRs   | `gh pr list`                           |
| View PR         | `gh pr view <number>`                  |
| Create PR       | `gh pr create -t "title" -b "body"`    |
| PR diff         | `gh pr diff <number>`                  |
| PR checks       | `gh pr checks <number>`                |
| Merge PR        | `gh pr merge <number> --squash -d`     |
| Checkout PR     | `gh pr checkout <number>`              |
| Review PR       | `gh pr review <number> --approve`      |
| Comment on PR   | `gh pr comment <number> -b "text"`     |
| List issues     | `gh issue list`                        |
| View issue      | `gh issue view <number>`               |
| Create issue    | `gh issue create -t "title" -b "body"` |
| My status       | `gh status`                            |
| Open in browser | `gh browse <number>`                   |
| Raw API call    | `gh api <endpoint>`                    |

## Pull Requests

### List

```
gh pr list [-s state] [-l label] [-a assignee] [-A author] [-B base] [-S search] [-L limit] [--json fields]
```

- **Default:** open PRs, limit 30
- **States:** `open` (default), `closed`, `merged`, `all`

### Create

```
gh pr create -t "title" -b "body" [-B base] [-H head] [-r reviewer] [-l label] [-a assignee] [-d] [-f]
```

- `-f` / `--fill` autofills title+body from commits
- `-d` marks as draft
- `--fill-verbose` uses commit msg+body for description
- `-F file` reads body from file; `-F -` reads stdin
- `--head branch` selects an already-pushed branch without automatic pushing or forking
- `--attach` uploads images or videos (see Attachments)

### Edit

```bash
gh pr edit 123 -R OWNER/REPO --body-file body.md
gh pr edit 123 -R OWNER/REPO --title "Updated title"
gh pr edit 123 -R OWNER/REPO --add-reviewer reviewer-login
gh pr edit 123 -R OWNER/REPO --add-label bug --remove-label triage
```

`--add-reviewer` also re-requests review. Project changes require the `project` auth scope.

### Attachments

Use `gh pr create --attach` or `gh pr edit --attach` with the existing CLI login. A browser upload is unnecessary.

```bash
# body.md contains: ![Login error](./login.png)
gh pr create -R OWNER/REPO --head feature --base main \
  --title "Fix login" --body-file body.md \
  --attach './login.png#Login error'

# Preserve the existing body and append an image.
gh pr edit 123 -R OWNER/REPO --attach './after.png#After the fix'
```

- Repeat `--attach` for multiple files, up to 50 per command.
- Use the exact same file path in the body and attachment flag. An absolute attachment path does not match a `./filename.png` body reference.
- Matching body references are rewritten to uploaded URLs. Otherwise, attachments are appended. Existing body references keep their alt text.
- Images accept `#alt text`; videos render as players and do not accept alt text.
- For more than 50 files, upload in batches. Fetch the updated body before each later body replacement to preserve uploaded URLs.
- For a PR template with sized images, upload first, then use the returned URLs in HTML such as `<img src="UPLOADED_URL" width="150">`.
- Partial upload failure can still create or update the PR. A nonzero exit status does not mean no change occurred. Check the printed PR URL and body before retrying.

### View

```
gh pr view [<number>|<url>|<branch>] [-c] [--json fields] [-w]
```

- `-c` shows comments
- `--json` fields: `additions, assignees, author, body, changedFiles, commits, files, headRefName, labels, mergeStateStatus, number, reviewDecision, reviews, state, statusCheckRollup, title, url` (and more)

### Merge

```
gh pr merge [<number>] [-m|--merge] [-s|--squash] [-r|--rebase] [-d] [--auto] [-b body]
```

- `-d` deletes branch after merge
- `--auto` enables auto-merge when checks pass

### Review

```
gh pr review [<number>] [-a|--approve] [-c|--comment] [-r|--request-changes] [-b body]
```

### Checks

```
gh pr checks [<number>] [--watch] [--required] [--json fields]
```

Exit code 8 = checks pending. `--watch` polls until done. `--fail-fast` exits on first failure.

### Diff

```
gh pr diff [<number>] [--name-only] [--patch]
```

### Comment

```
gh pr comment [<number>] -b "text"
gh pr comment [<number>] --edit-last -b "updated"
gh pr comment [<number>] --delete-last --yes
```

## Issues

### List

```
gh issue list [-s state] [-l label] [-a assignee] [-A author] [-S search] [-m milestone] [-L limit] [--json fields]
```

- **Default:** open issues, limit 30

### Create

```
gh issue create -t "title" -b "body" [-l label] [-a assignee] [-m milestone] [-p project]
```

- `-a @me` self-assigns

### View

```
gh issue view <number> [-c] [--json fields] [-w]
```

### Other

```
gh issue close <number>
gh issue reopen <number>
gh issue comment <number> -b "text"
gh issue edit <number> [--add-label x] [--title "new"]
gh issue develop <number>          # manage linked branches
```

## Search

### Issues/PRs

```
gh search issues <query> [--repo R] [--owner O] [--state S] [--label L] [--assignee A] [--author A] [-L limit]
```

- `--include-prs` to include PRs
- Sort: `comments`, `created`, `interactions`, `reactions`, `updated` (default: `best-match`)

### Code

```
gh search code <query> [--repo R] [--owner O] [--language L] [--filename F] [--extension E] [-L limit]
```

### Exclude syntax

Use `--` before query with `-` prefix: `gh search issues -- "-label:bug"`

## Actions / Runs

```
gh run list [-L limit] [--json fields]
gh run view <run-id> [-v] [--log] [--log-failed] [-j job-id] [--web]
gh run watch <run-id>
gh run rerun <run-id> [--failed]
```

- `-v` shows job steps
- `--log-failed` shows only failed step logs

## Raw API

```
gh api <endpoint> [-X method] [-F key=value] [-f key=value] [-H header] [--jq expr] [--paginate] [--cache duration]
```

- Use a REST endpoint such as `repos/OWNER/REPO/pulls`, or `graphql` for v4
- `-F` converts booleans, integers, and `null`, resolves placeholders, and reads `@file` or `@-`; `-f` sends raw strings
- Adding `-F` or `-f` changes the default method from GET to POST. Use `--method GET` for query parameters on read requests
- `--input file.json` reads a request body; `--input -` reads stdin. With `--input`, field flags become query parameters
- `--paginate --slurp` wraps pages in an outer JSON array; it does not flatten page arrays
- GraphQL pagination requires an `$endCursor: String` variable and `pageInfo { hasNextPage endCursor }`
- `--jq` filters response (jq syntax)
- `--cache 1h` caches response

### Common API Patterns

```bash
# Inline PR review comments
gh api 'repos/{owner}/{repo}/pulls/123/comments' --paginate

# PR conversation comments (PRs also use issue endpoints)
gh api 'repos/{owner}/{repo}/issues/123/comments' --paginate

# PR reviews
gh api 'repos/{owner}/{repo}/pulls/123/reviews' --paginate

# Issue timeline
gh api 'repos/{owner}/{repo}/issues/123/timeline' --paginate

# GET parameters: keep the method explicit
gh api --method GET 'repos/{owner}/{repo}/pulls' -f state=all -F per_page=100 --paginate

# Repo info
gh api 'repos/{owner}/{repo}'

# User info
gh api user
```

## Other Commands

| Command                       | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `gh status`                   | Assigned issues/PRs, review requests, mentions across all repos |
| `gh browse [number\|path]`    | Open in browser (`-n` prints URL instead)                       |
| `gh browse main.go:312`       | Open file at line in browser                                    |
| `gh gist create -f name file` | Create gist                                                     |
| `gh gist list`                | List your gists                                                 |
| `gh release list`             | List releases                                                   |
| `gh release create tag`       | Create release                                                  |
| `gh repo view`                | View repo info                                                  |
| `gh repo clone OWNER/REPO`    | Clone repo                                                      |
| `gh label list [-S search]`   | List/search labels                                              |

## JSON Output

Most commands support `--json fields` + `--jq expr` for structured output:

```bash
gh pr list --json number,title,headRefName --jq '.[] | "\(.number) \(.title)"'
gh issue list --json number,title,labels --jq '.[] | select(.labels | length > 0)'
```
