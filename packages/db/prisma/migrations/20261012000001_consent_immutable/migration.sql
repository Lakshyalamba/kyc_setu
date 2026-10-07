-- AlterTable
ALTER TABLE "consent_versions" ADD COLUMN "supersededAt" TIMESTAMP(3);

-- A published consent text is what a customer agreed to. It can be replaced by a newer version, never edited:
-- text, version and effective date are frozen, supersededAt can be set exactly once, and rows cannot be deleted
-- (sessions point at them). TRUNCATE is deliberately not blocked (test cleanup, `make reset`).
CREATE OR REPLACE FUNCTION consent_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_versions is immutable (DELETE not allowed)';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."bodyMarkdown" IS DISTINCT FROM OLD."bodyMarkdown"
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'consent_versions is immutable: the text, version and effective date of a published consent cannot change';
  END IF;
  IF OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" THEN
    RAISE EXCEPTION 'consent_versions.supersededAt is set once and cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_versions_immutable
BEFORE UPDATE OR DELETE ON "consent_versions"
FOR EACH ROW EXECUTE FUNCTION consent_versions_guard();
