-- refund items and audit improvements
CREATE TABLE refund_items (
    id BIGSERIAL PRIMARY KEY,
    refund_id UUID NOT NULL REFERENCES refunds (id),
    sku VARCHAR(64) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    CONSTRAINT uq_item UNIQUE (refund_id, sku)
);

ALTER TABLE refunds ADD COLUMN reason TEXT;
ALTER TABLE refunds ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE audit_log ADD COLUMN refund_id UUID;
ALTER TABLE audit_log ADD CONSTRAINT fk_audit_refund FOREIGN KEY (refund_id) REFERENCES refunds (id);
