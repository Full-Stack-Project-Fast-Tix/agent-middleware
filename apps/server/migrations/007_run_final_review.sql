-- The saved outcome of a Run's final review of its actual changes, success or
-- failure (finalReviewSchema in packages/shared/src/review.ts). NULL for Runs
-- recorded before it existed, which the UI reports as unknown, never aligned.
ALTER TABLE runs ADD COLUMN final_review jsonb;
