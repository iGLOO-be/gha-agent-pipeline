# 03: Mark an implement pull request at creation

**What to build:** An implement pull request is recognizable the moment it is created, before any label is added. Its body carries the implement mark `agent-pr-implement` in addition to the existing agent pull request mark. A yolo pull request does not carry the implement mark, and still carries the existing agent pull request mark. When pull request creation is skipped, no body and no implement mark are written.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] An implement pull request body contains `agent-pr-implement` and the existing agent pull request mark
- [x] A yolo pull request body does not contain `agent-pr-implement` and still contains the existing agent pull request mark
- [x] Skipping pull request creation writes no implement mark

## Answer

An implement pull request body includes `<!-- agent-pr-implement -->` and `<!-- agent-pr -->`. A yolo body keeps `<!-- agent-pr -->` only. Both phases return before building a body when pull request creation is skipped. Landed on `feat/pr-opened-review` as `d98e9d3`.
