-- Store the active shift's operator_name on each transaction at completion time.
ALTER TABLE transactions ADD COLUMN operator_name TEXT;
