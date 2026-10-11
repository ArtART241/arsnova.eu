-- Avoid triggered_data_change_violation (SQLSTATE 27000) when the cleanup
-- function deletes from SessionFeedback during a SessionFeedback DELETE.
DROP TRIGGER IF EXISTS "SessionFeedback_cleanup_detached_retention" ON "SessionFeedback";

CREATE TRIGGER "SessionFeedback_cleanup_detached_retention"
AFTER DELETE ON "SessionFeedback"
FOR EACH STATEMENT
EXECUTE FUNCTION arsnova_cleanup_detached_retention_records();
