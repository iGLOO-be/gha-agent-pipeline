# 04: Run the trigger on this repository

**What to build:** On this repository, a pull request that becomes reviewable in the same repository, and that the shared decision accepts, dispatches one code review through the existing phase workflow. The review's diff uses that pull request's base, and checkout uses the head branch tip. A manual code review keeps the base it uses today. Forks, drafts, closed pull requests, implement pull requests, and pull requests that already have a PR-opened review produce no comment. No new agent-config flag is added. Model credentials stay on the phase workflow. There is no slash comment to react to, and a missing comment id does not fail the run.

**Blocked by:**

- 01 — Decide whether a pull request gets a PR-opened review
- 02 — Publish at most one marked PR-opened review
- 03 — Mark an implement pull request at creation

**Status:** resolved

- [x] This repository listens for `opened` and `ready_for_review` and calls the reusable gate with a runner input
- [x] The gate uses the shared decision, then dispatches the existing phase workflow as a code review with the review loop inactive and chaining off
- [x] The phase workflow accepts an optional comment id and a PR-opened review input, and passes the pull request base only for this trigger
- [x] An empty comment id publishes no reaction
- [x] Setup and the review job's runner stay on the consumer phase workflow
- [x] A skipped pull request produces no comment
- [x] Dogfood enables the trigger with no new agent-config flag

Dogfood `agent-on-pr-opened.yml` calls `agent-pr-opened-review.yml` with `blacksmith-4vcpu-ubuntu-2404`. The gate reads `git.branch_prefix` (default `agent`), calls `decidePrOpenedReview`, and on a dispatch POSTs `agent-phase.yml` on the default branch. Inputs are `phase` and `runtime_phase` `code-review`, `issue_number`, `pr_number`, `head_ref`, `base_branch`, `pr_opened_review` `true`, `review_loop_active` `false`, and `chain_code_review` `false`. There is no `comment_id`. A silent skip posts no comment and dispatches nothing. `agent-phase.yml` defaults an omitted `base_branch` to `main` and forwards `pr_opened_review` into `agent-phase-run`, which sets `PR_OPENED_REVIEW` to `true` only when that input is `true`. Review fixes landed as `7f4ba7c`: a dispatched review still starts if the pull request closes, and only the full HTML comments count as marks. An empty `comment_id` publishes no reaction.
