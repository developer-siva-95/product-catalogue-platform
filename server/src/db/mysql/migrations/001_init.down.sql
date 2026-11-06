-- ---------------------------------------------------------------------------
-- 001_init (down) — drops the catalogue schema.
-- ---------------------------------------------------------------------------
-- Destructive by definition. The migration runner refuses to execute a `down`
-- file unless ALLOW_DESTRUCTIVE_MIGRATIONS=true *and* the target database name
-- ends with `_test` (or is listed in MYSQL_ALLOWED_DESTRUCTIVE_DATABASES), so it
-- can never be pointed at a real catalogue by accident.
--
-- Child tables first: products holds the foreign keys into brands/categories.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS brands;
