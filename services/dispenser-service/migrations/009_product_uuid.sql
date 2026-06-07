-- Add stable UUID column to products table.
-- Existing rows get a placeholder; the application will overwrite with real UUIDs
-- on next startup via save_products_to_db (which is called whenever products are saved).
ALTER TABLE products ADD COLUMN uuid TEXT NOT NULL DEFAULT '';
