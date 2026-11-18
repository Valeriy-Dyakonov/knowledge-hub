CREATE TABLE tmp_import (id INT);
DROP TABLE IF EXISTS tmp_import;
ALTER TABLE refunds RENAME COLUMN reason TO refund_reason;
