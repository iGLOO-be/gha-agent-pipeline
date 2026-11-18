# 01: Decide whether a pull request gets a PR-opened review

**What to build:** A maintainer can tell, for any pull request event, whether it should start one PR-opened review or be skipped in silence. A reviewable pull request in the same repository, with no implement mark and no published PR-opened review, produces the exact code-review dispatch: the same issue number a slash code review would use, the pull request number, the head branch, that pull request's base, the review loop left inactive, and chaining left off. A fork, a draft that was only opened, a pull request that is closed when the decision runs, an implement pull request, or a pull request that already has a PR-opened review produces no dispatch and no comment.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] A reviewable same-repository pull request with no implement mark and no published PR-opened review yields a dispatch payload
- [x] The issue number is parsed from `branch_prefix/<id>-` on the head branch, and is the pull request number otherwise
- [x] The payload carries the head branch name, not the SHA from the opening event, and the pull request's own base ref
- [x] The payload marks the run as a PR-opened review, leaves the review loop inactive, and leaves chaining off
- [x] A head branch in another repository is a silent skip
- [x] An `opened` draft is a silent skip, and `ready_for_review` is not
- [x] A pull request that is closed when the decision runs is a silent skip
- [x] A body containing the implement mark `agent-pr-implement` is a silent skip
- [x] Any existing review body containing `agent-pr-opened-review` is a silent skip, including a dismissed review
- [x] Path filters are not a skip reason
- [x] Events other than `opened` and `ready_for_review` are a silent skip

## Answer

`decidePrOpenedReview` in the shared script returns `{ outcome: "silent-skip" }` or a dispatch payload with the issue number, pull request number, head branch, base ref, PR-opened review on, review loop off, and chaining off. A silent skip has no reason and posts no comment. Landed on `feat/pr-opened-review` as `55e6ec6`.
