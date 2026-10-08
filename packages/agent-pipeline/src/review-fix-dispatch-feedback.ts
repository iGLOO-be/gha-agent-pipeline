/** Slash trigger text in manual `workflow_dispatch` (runtime reloads review context). */
export const REVIEW_FIX_TRIGGER_MAX_CHARS = 8_000;

/** Synthesized feedback for review-loop chained review-fix dispatches. */
export const REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS = 60_000;

/** @deprecated Use REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS */
export const REVIEW_FIX_FEEDBACK_MAX_CHARS =
  REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS;

export type TruncateReviewFixFeedbackOptions = {
  maxChars: number;
  sourceUrl?: string;
};

/**
 * Keep `workflow_dispatch` `review_feedback` under GitHub's per-input size ceiling.
 */
export function truncateReviewFixFeedbackForDispatch(
  feedback: string,
  options: TruncateReviewFixFeedbackOptions,
): string {
  const { maxChars, sourceUrl } = options;
  if (feedback.length <= maxChars) {
    return feedback;
  }
  const urlPart = sourceUrl ? ` (${sourceUrl})` : "";
  const note = `\n…(review feedback truncated to fit the workflow_dispatch input limit; read the posted review on GitHub${urlPart} for the full text)`;
  const budget = Math.max(0, maxChars - note.length);
  return `${feedback.slice(0, budget)}${note}`;
}
