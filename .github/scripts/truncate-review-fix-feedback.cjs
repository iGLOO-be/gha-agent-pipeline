"use strict";

// Keep in sync with packages/agent-pipeline/src/review-fix-dispatch-feedback.ts

const REVIEW_FIX_TRIGGER_MAX_CHARS = 8_000;
const REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS = 60_000;

function truncateReviewFixFeedbackForDispatch(feedback, options = {}) {
  const maxChars = options.maxChars ?? REVIEW_FIX_TRIGGER_MAX_CHARS;
  const sourceUrl = options.sourceUrl;
  if (feedback.length <= maxChars) {
    return feedback;
  }
  const urlPart = sourceUrl ? ` (${sourceUrl})` : "";
  const note = `\n…(review feedback truncated to fit the workflow_dispatch input limit; read the posted review on GitHub${urlPart} for the full text)`;
  const budget = Math.max(0, maxChars - note.length);
  return `${feedback.slice(0, budget)}${note}`;
}

module.exports = {
  REVIEW_FIX_TRIGGER_MAX_CHARS,
  REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS,
  truncateReviewFixFeedbackForDispatch,
};
