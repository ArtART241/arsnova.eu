-- Fix: Prevent PostgreSQL Deadlock (Code 27000) during session feedback deletion
DROP TRIGGER IF EXISTS "SessionFeedback_cleanup_detached_retention" ON "SessionFeedback";

CREATE TRIGGER "SessionFeedback_cleanup_detached_retention"
AFTER DELETE ON "SessionFeedback"
FOR EACH STATEMENT
EXECUTE FUNCTION arsnova_cleanup_detached_retention_records();
