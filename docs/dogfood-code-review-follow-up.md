# Dogfood: code-review follow-up demo

Repeatable demo for the **repeat `/agent code-review`** flow: open thread triage,
`resolveReviewThreads`, and delta diff since the last agent review.

## Prerequisites

- **Secrets:** `APP_ID`, `APP_PRIVATE_KEY`, `OPENROUTER_API_KEY` in the repo
  settings (or inherited from the organization).
- **App permissions:** The GitHub App must have Contents, Issues, Pull Requests,
  and Actions read & write on this repo.
- **Workflows:** All consumer workflows (`agent.yml`, `agent-phase.yml`,
  `agent-on-ci-failure.yml`, `agent-on-ci-success.yml`, `ci.yml`) must exist on
  **`main`**.
- **Config:** `.github/agent.config.yml` at the repo root with a valid
  `code_review` block. The follow-up fields default to safe values if absent.

## Config

The follow-up behavior is controlled by
`code_review.follow_up.resolve_threads` in
[`.github/agent.config.yml`](../.github/agent.config.yml):

| Value         | Effect                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| `agent_only`  | Resolve only threads where the **last comment is from the agent** (default). |
| `all_authors` | Resolve threads **regardless of the last commenter**.                        |
| `off`         | Never resolve review threads.                                                |

Example:

```yaml
code_review:
  follow_up:
    resolve_threads: agent_only
```

## Demo steps

### 1. Kick off with `/agent yolo`

Open or pick an issue and comment:

```
/agent yolo
```

Wait for the agent PR (labelled `agent-pr`) and CI to pass.

### 2. First `/agent code-review`

On the agent PR, comment:

```
/agent code-review
```

The agent posts a GitHub review (inline comments + summary body with
**Walkthrough**, **Merge risk**, **Standards**, **Spec**). Open threads are
left for human follow-up.

### 3. Address feedback

Fix the issues flagged in the review. You can do this manually and push, or
comment on the PR:

```
/agent fix
```

Push at least one commit that addresses (or rejects) the open threads.

### 4. Second `/agent code-review`

Comment again on the PR:

```
/agent code-review
```

## What to look for

- **`## Follow-up` section** — appears at the top of the review body when
  the agent detects a previous review. It lists each open thread, the current
  code state, and whether the thread was resolved.
- **Resolved threads** — threads where the fix is confirmed show as
  `RESOLVED` in the follow-up summary. The agent calls `resolveReviewThreads`
  on those threads (subject to `resolve_threads` config).
- **Delta diff** — the agent prompt includes only the **diff since the last
  agent review**, not the full PR diff. This keeps the second review focused
  on new or changed code.
- **Config:** when in doubt, check the `resolve_threads` value in the
  agent.log or repo config. `agent_only` is the safe default.
