create table refunds (
    id uuid primary key,
    amount numeric not null,
    status varchar(32) not null
);

CREATE TABLE IF NOT EXISTS audit_log (text varchar(255));
