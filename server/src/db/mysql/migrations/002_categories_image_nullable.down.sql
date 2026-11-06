-- ---------------------------------------------------------------------------
-- 002 (down) — restore image as NOT NULL DEFAULT ''
-- ---------------------------------------------------------------------------
-- Existing NULLs are folded to '' first, so the ALTER cannot fail on data.
-- ---------------------------------------------------------------------------

UPDATE categories SET image = '' WHERE image IS NULL;

ALTER TABLE categories
  MODIFY COLUMN image VARCHAR(500) NOT NULL DEFAULT '';
