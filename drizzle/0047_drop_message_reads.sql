-- migration-safety: allow drop-table (superseded by last_read_message_id in 0035; the only instance is a dev one with disposable data)
DROP TABLE "message_reads" CASCADE;