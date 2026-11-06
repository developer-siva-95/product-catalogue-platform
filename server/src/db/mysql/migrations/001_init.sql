-- ---------------------------------------------------------------------------
-- 001_init — MySQL schema for the catalogue (MySQL 8.0.44, InnoDB)
-- ---------------------------------------------------------------------------
-- Design notes (each rule below exists to make MySQL behave byte-identically to
-- the MongoDB reference implementation):
--
--  * Primary keys are CHAR(24) holding the same 24-hex-character ids MongoDB
--    uses. `CHARACTER SET ascii COLLATE ascii_bin` makes comparison and ORDER BY
--    pure byte order, which is exactly how Mongo compares ObjectIds — so
--    `ORDER BY id DESC` reproduces `sort({ _id: -1 })`, and the ids a client
--    already holds keep working across providers.
--  * Searchable free text (title / description / name) uses the table collation
--    utf8mb4_0900_as_ci, which matches Mongo's /i regex semantics (case- and
--    accent-insensitive). Ordering-sensitive identity columns (slug, sku, email,
--    name_normalized) are pinned to utf8mb4_bin so UNIQUE behaves like Mongo's
--    binary unique index ("Cafe" and "Café" stay distinct, as they do in Mongo).
--  * Money is DECIMAL(12,2): exact to the cent and able to hold the app's
--    PRICE_MAX of 1e9. mysql2 returns DECIMAL as a string, so the repository
--    layer converts it to a JS number (see repositories/mysql/*.repository.js).
--  * Timestamps are DATETIME(3) so millisecond precision round-trips through the
--    pool's `timezone: 'Z'` and the JSON payload keeps the same ISO strings.
--  * `version` is Mongo's `__v`: optimistic concurrency is a guarded UPDATE
--    (`... WHERE id = ? AND version = ?`), and `affectedRows = 0` means the
--    caller is stale (HTTP 409), mirroring Mongoose's VersionError.
--  * `stock` updates are guarded (`WHERE stock >= ?`) inside a transaction, so
--    concurrent decrements can never oversell — the MySQL equivalent of the
--    atomic `$inc` + `$expr` guard on the Mongo side.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS brands (
  id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(60) NOT NULL,
  name_normalized VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  slug VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  logo VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY brand_name_normalized_unique (name_normalized),
  UNIQUE KEY brand_slug_unique (slug),
  KEY brand_name_order (name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS categories (
  id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(60) NOT NULL,
  name_normalized VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  slug VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  image VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY category_name_normalized_unique (name_normalized),
  UNIQUE KEY category_slug_unique (slug),
  KEY category_name_order (name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS products (
  id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(160) NOT NULL,
  slug VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  -- NULL (not '') models Mongo's sparse unique SKU index: several products may
  -- have no SKU because MySQL treats NULLs as distinct in a UNIQUE key.
  sku VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  price DECIMAL(12, 2) NOT NULL,
  stock INT NOT NULL,
  description VARCHAR(5000) NOT NULL,
  image VARCHAR(500) NOT NULL DEFAULT '',
  thumbnail VARCHAR(500) NOT NULL DEFAULT '',
  brand_id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category_id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  version INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY product_slug_unique (slug),
  UNIQUE KEY product_sku_unique_sparse (sku),
  KEY product_brand_category_price (brand_id, category_id, price),
  KEY product_active_newest (is_active, id),
  KEY product_active_price_asc (is_active, price, id),
  KEY product_active_price_desc (is_active, price DESC, id DESC),
  KEY product_active_brand (is_active, brand_id),
  KEY product_active_category (is_active, category_id),
  KEY product_created_at (created_at),
  FULLTEXT KEY product_text_search (title, description),
  CONSTRAINT product_price_range CHECK (price >= 0),
  CONSTRAINT product_stock_range CHECK (stock >= 0),
  CONSTRAINT product_brand_fk FOREIGN KEY (brand_id) REFERENCES brands (id),
  CONSTRAINT product_category_fk FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  -- Emails are lower-cased by the application before they reach the store, so a
  -- binary unique index reproduces Mongo's exact-match uniqueness.
  email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'customer',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  password_changed_at DATETIME(3) NULL,
  token_version INT NOT NULL DEFAULT 0,
  login_attempts INT NOT NULL DEFAULT 0,
  lock_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email_unique (email),
  CONSTRAINT user_role_check CHECK (role IN ('admin', 'customer')),
  CONSTRAINT user_token_version_check CHECK (token_version >= 0),
  CONSTRAINT user_login_attempts_check CHECK (login_attempts >= 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_as_ci;
