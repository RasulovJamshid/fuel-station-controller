-- AZT owns this journal; other protocol runtimes do not read or write it.
CREATE TABLE azt_recovery (
    site_id TEXT NOT NULL,
    fp_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (site_id, fp_id)
);
