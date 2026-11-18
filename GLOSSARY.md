# Agent pipeline

Vocabulary for the phases that change a repository on GitHub, and for the ways a code review of a pull request starts.

## Language

### Phases

**Implement**:
The phase that carries out a plan and opens the pull request for that work.
_Avoid_: yolo

**Yolo**:
The phase that carries out an issue directly and opens the pull request for that work.
_Avoid_: implement

**Review-fix**:
The phase that updates a pull request in response to a code review.
_Avoid_: fix

### Reviews

**Code review**:
A read-only assessment of a pull request diff, published on that pull request.
_Avoid_: review mode, automatic review

**Review loop**:
The alternation of code review and review-fix that begins from a successful implement.
_Avoid_: PR-opened review, chained code-review

**Chained code-review**:
A single code review that follows one implement or one review-fix.
_Avoid_: review loop, PR-opened review

**PR-opened review**:
A single code review that starts when a pull request becomes reviewable, outside the review loop and outside a chained code-review.
_Avoid_: review loop, chained code-review, review mode

### Pull requests

**Agent pull request**:
A pull request opened by implement or yolo.
_Avoid_: human pull request

**Implement pull request**:
An agent pull request opened by implement.
_Avoid_: yolo pull request

**Reviewable**:
An open pull request that is not a draft.
_Avoid_: draft
