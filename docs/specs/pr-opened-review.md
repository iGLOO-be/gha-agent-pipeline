# PR-opened review

## Problem Statement

A pull request becomes reviewable with no code review unless someone comments `/agent code-review`, or unless implement starts a review loop or a chained code-review. Human pull requests, Dependabot pull requests, Renovate pull requests, and yolo pull requests are not reviewed when they become reviewable. Implement pull requests already have an owner for that first review, and a second automatic review would duplicate it.

## Solution

When a pull request in the same repository becomes reviewable, a consumer who has wired the trigger gets one PR-opened review: a single code review, with no review-fix and no review loop. Implement pull requests are left to the review loop, the chained code-review, or to silence when both are off. Forks, drafts, closed pull requests, and a pull request that already has a published PR-opened review are skipped without a comment.

## User Stories

1. As a maintainer of a consumer repository, I want a pull request that becomes reviewable to receive one code review, so that human work is reviewed without a slash command.
2. As a maintainer, I want that review to be the existing code review, so that the walkthrough, merge risk, standards, and spec axes stay the ones I already know.
3. As a maintainer, I want the review loop to stay something that only a successful implement starts, so that a human pull request is not auto-fixed.
4. As a maintainer, I want no review-fix to start from a PR-opened review, so that a `REQUEST_CHANGES` waits for a human.
5. As a human author, I want a non-draft pull request I open in the same repository to get one code review, so that I get feedback on the diff I opened.
6. As a human author, I want a draft to receive nothing until I mark it ready, so that unfinished work is not reviewed.
7. As a human author, I want marking a draft ready to start one PR-opened review, so that the review sees the pull request once it is reviewable.
8. As a human author, I want a later push to leave the published PR-opened review as the only automatic one, so that every commit does not start another review.
9. As a human author, I want a push that lands before the review job checks out to be included, so that a fast follow-up commit is part of that single review.
10. As a human author, I want the review diff to be against my pull request's base branch, so that a pull request into a branch other than the configured default is still reviewed as GitHub shows it.
11. As a human author, I want reopening a pull request to do nothing, so that an old review is not repeated.
12. As a human author, I want a pull request I close before the gate runs to be skipped with no comment, so that a retracted pull request does not spend a review.
13. As a human author, I want a pull request whose every changed file is excluded by the code review path filters to still run the code review, so that this trigger matches a manual code review of the same diff.
14. As a human author, I want a failed PR-opened review to leave the usual code-review failure comment, so that I can see that the run did not publish a review.
15. As a human author, I want to rerun a failed PR-opened review, so that a transient failure can still publish the one review.
16. As a human author, I want a second ready-for-review, or a rerun after a published review, to do nothing, so that I do not get a duplicate PR-opened review.
17. As a human author, I want dismissing the published review to still count as the one PR-opened review, so that dismissal is not a hidden second trigger.
18. As a human author, I want to comment `/agent code-review` as well, so that a manual code review stays available and is a separate review.
19. As a human author, I want a manual code review to keep the base branch it uses today, so that this trigger does not change slash behavior.
20. As a human author, I want a skipped fork, draft, closed pull request, implement pull request, or already-published review to add no explanation comment, so that the pull request stays quiet.
21. As a fork contributor, I want no PR-opened review, so that my head is not checked out with the repository's secrets.
22. As a Dependabot or Renovate identity opening a pull request from a branch in the same repository, I want one PR-opened review, so that bot pull requests are reviewed like human ones.
23. As a person who runs yolo, I want the pull request yolo opens to receive one PR-opened review, so that yolo still gets a review without entering the review loop.
24. As a person who runs yolo, I want that review to be yolo's only automatic code review, so that yolo does not also start a chained code-review.
25. As a person who runs yolo, I want a `REQUEST_CHANGES` verdict on that pull request to be published the way the code review already publishes a review on a pull request the App opened, so that this trigger does not invent a second posting rule.
26. As a person who runs implement, I want the new pull request to keep the review loop when that loop is enabled, so that implement still alternates code review and review-fix.
27. As a person who runs implement, I want the chained code-review when the loop is off and the implement follow-up is on, so that the existing single follow-up remains the review.
28. As a person who runs implement, I want no automatic review when the loop and the implement follow-up are both off, so that turning both off stays silent on purpose.
29. As a person who runs implement, I want the PR-opened review to skip that pull request, so that implement does not get a second code review from the pull request event.
30. As a maintainer, I want an implement pull request to be recognizable as soon as it is created, so that the gate can skip it before the `agent-pr` label exists.
31. As a maintainer, I want a yolo pull request to be distinguishable from an implement pull request at creation, so that yolo is not skipped by the same signal.
32. As a maintainer, I want the opt-in to be wiring a workflow, so that a consumer who does not wire it gets no PR-opened review.
33. As a maintainer, I want no new enabled flag in the agent config, so that the code review model, path filters, and labels stay the ones already configured.
34. As a maintainer, I want the trigger workflow to choose the runner, so that the library does not pick the machine that applies the gate.
35. As a maintainer, I want environment setup and the review job's runner to stay in my phase workflow, so that the library still does not own checkout, Node, or the App token.
36. As a maintainer, I want the gate to dispatch my existing phase workflow as a code review, so that there is one place that checks out, sets up, and runs the phase.
37. As a maintainer, I want that dispatch to leave the review loop inactive and to leave chaining off, so that the phase does not continue into review-fix.
38. As a maintainer, I want the issue number on that run to match a slash code review of the same branch, so that a `branch_prefix/<id>-…` branch still loads the source issue and any other branch uses the pull request number.
39. As a maintainer, I want this run to queue behind another phase already running for that same issue number, so that two agent sessions do not review the same pull request at once.
40. As a maintainer, I want yolo's in-progress label on the source issue not to block the PR-opened review, so that yolo's pull request still gets its one review.
41. As a maintainer, I want a PR-opened review to have no slash comment to react to, so that a missing comment id does not fail the run.
42. As a maintainer, I want a published PR-opened review to carry a marker that manual code reviews do not carry, so that "already published" does not treat a manual code review as this trigger.
43. As a maintainer, I want a second run that was already queued to stop before the model if that marker is present, so that a race does not pay for two reviews.
44. As a maintainer, I want the marker to be written only when a review is actually published, so that a failure can be rerun.
45. As a maintainer of this repository, I want the dogfood consumer to wire the trigger, so that this repo reviews its own non-implement pull requests.
46. As a maintainer, I want a code review that starts and then fails to keep the phase's existing failure comment, and a code review that starts successfully to keep the phase's existing startup comment, labels, and run footer, so that this trigger does not invent a second publication format.
47. As a maintainer, I want a review that was already dispatched to finish even if the pull request is later marked draft or closed, so that the gate does not try to cancel a running phase.

## Implementation Decisions

- The vocabulary in the glossary is the one used here: code review, review loop, chained code-review, PR-opened review, implement, yolo, review-fix, agent pull request, implement pull request, reviewable. No ADR is added.
- A consumer opts in by listening to `pull_request` types `opened` and `ready_for_review` and calling a library reusable workflow. That workflow takes a runner input. It does not set up the language toolchain and it does not run the model. Dogfood calls the reusable workflow in-repo. Other consumers pin a release.
- The reusable workflow dispatches the consumer's existing phase workflow with the code review phase. Review-loop inputs stay inactive. Chaining stays off. The phase workflow remains the owner of setup and of the review job's runner.
- The dispatch carries the pull request's base ref as the code review base for this trigger only. A slash code review keeps whatever base the consumer phase workflow already supplies when the new input is omitted.
- The dispatch carries the head branch name and does not pin checkout to the SHA from the `opened` event. The review sees the branch tip at checkout.
- Issue number resolution matches slash code review: parse `branch_prefix/<id>-` from the head branch using the configured prefix, otherwise use the pull request number.
- The phase workflow's comment id becomes optional. An empty comment id publishes no reaction. A new input records that this run is a PR-opened review, forwarded the same way as the review loop inputs.
- The phase concurrency group stays keyed by issue number, so a PR-opened review queues behind an in-progress phase for that number. The gate does not treat yolo's working label on the source issue as a reason to skip.
- The agent pull request body builder gains an implement origin. Only implement writes an implement mark into the body at creation, in addition to the existing agent-pull-request mark. Yolo does not write the implement mark. No pull request is created when pull request creation is skipped, so no mark is written in that case.
- The implement mark is the HTML comment `agent-pr-implement`. The existing "PR opened by this run" comment mark stays a different signal and is not the once-only signal.
- The once-only signal is the HTML comment `agent-pr-opened-review` on the published code review body. The runner writes it when, and only when, the run is a PR-opened review and a review is published, including when the fallback publisher posts the review. A manual code review does not receive it. A run that publishes no review does not write it.
- One pure decision owns every gate outcome. Its inputs are the pull request event, the live pull request, the bodies of existing reviews, and the configured branch prefix. Its output is either a silent skip or a dispatch payload: issue number, pull request number, head branch, base ref, PR-opened review set, review loop inactive, chaining off. Skip reasons are: head repository is not the base repository, the pull request is not reviewable (`opened` while draft), the live pull request is closed, the body contains the implement mark, or any existing review body already contains the PR-opened review mark (including a dismissed review). `ready_for_review` is reviewable. `reopened` and `synchronize` are not events this trigger listens to. Path filters are not a skip reason.
- The gate calls that decision before dispatch. The code review phase calls the same decision before it announces a startup and before it calls the model, so a queued duplicate exits without a second review and without a startup comment.
- Skips produce no comment. A code review that starts and fails still uses the phase's existing failure comment. Labels, the startup comment, and the run footer stay the phase's existing behavior for a review that actually starts.
- There is no new agent-config flag and no schema property for enabling this trigger.
- The gate's token can read the pull request and dispatch the phase workflow. Model credentials stay on the phase workflow.
- The code review's own-PR fallback is unchanged. On a yolo pull request the App is the author, so a requested changes event may be published as a comment. Labels still follow the event the agent chose.

## Testing Decisions

A good test asserts behavior a caller can observe: skip or dispatch payload, marks present or absent in a body, and whether a second PR-opened review is refused before the model. It does not assert workflow expression syntax, runner labels, or the order of unrelated comments.

One new seam, the pure decision above, is the seam for this feature. The gate and the code review phase both call it, so the fork, draft, closed, implement-mark, already-published, issue-number, and base-ref rules are tested once. Prior art is the pure helpers extracted for the slash dispatch workflow and tested without running Actions.

Two existing seams grow only by the marks they already own. The agent pull request body builder is tested the way it is tested today: an implement origin contains the implement mark, a yolo origin does not, and the existing agent-pull-request mark remains on both. The code review publisher is tested the way review bodies are tested today: a PR-opened review publication contains both the code review mark and the PR-opened review mark, a publication that is not a PR-opened review does not contain the PR-opened review mark, and the fallback publisher follows the same rule. The early exit before startup and before the model is the decision returning skip, not a second predicate.

Workflow files are not a test seam. The own-PR publication fallback already has tests and is not retested here.

## Out of Scope

- An ADR, a config flag, or a schema property that turns the trigger on.
- Changing the review loop, the chained code-review, or review-fix.
- Starting a review from `synchronize` or `reopened`.
- Reviewing forks, or using a trigger that checks out fork code with secrets.
- Changing the base branch used by a manual code review.
- Changing how a code review is posted when the App is the pull request author.
- Cancelling a review that has already been dispatched.
- Backfilling pull requests that are already open.
- A rate limit beyond one PR-opened review per pull request.
- Any other product improvement outside this trigger.

## Further Notes

- The shared understanding from the design session is the contract. Where this spec names a mark, that string is the contract the gate and the publisher share.
- Dogfood already enables the review loop. Implement pull requests in this repository keep that loop and are skipped by PR-opened review. Yolo pull requests in this repository get the PR-opened review.
- A pull request event still creates a workflow run on the consumer even when the reusable job skips. That is the same shape as slash dispatch, which filters inside the called workflow.
