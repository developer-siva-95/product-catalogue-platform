-- ---------------------------------------------------------------------------
-- 002 — `categories.image` becomes nullable
-- ---------------------------------------------------------------------------
-- The MongoDB category schema never declared `image`; a category document only
-- carries the key if someone inserted it directly (the demo/snapshot fixtures do,
-- with an empty string). A `NOT NULL DEFAULT ''` column cannot tell "absent" from
-- "present but empty", so the API would either always or never emit the key and
-- the JSON could not match the reference provider.
--
-- NULL now means "no image field" (the API omits the key), while '' means "the
-- field exists and is empty" (the API returns ""), which is exactly the Mongo
-- semantics. Application-written categories store NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE categories
  MODIFY COLUMN image VARCHAR(500) NULL DEFAULT NULL;
