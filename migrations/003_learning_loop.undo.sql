ALTER TABLE progress
  DROP CONSTRAINT IF EXISTS progress_user_sub_stage_unique;

ALTER TABLE puzzle_results
  DROP COLUMN IF EXISTS sub_stage_id;
