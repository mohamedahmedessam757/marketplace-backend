SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'disputes_status_check';
