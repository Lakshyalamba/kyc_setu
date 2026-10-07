-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_RESUBMIT');

-- CreateEnum
CREATE TYPE "ReasonCode" AS ENUM ('IDENTITY_MISMATCH', 'DOCUMENT_TAMPERED', 'FACE_MISMATCH', 'DUPLICATE_IDENTITY', 'AGE_INELIGIBLE', 'POOR_IMAGE_QUALITY', 'WRONG_DOCUMENT', 'SIGNATURE_UNCLEAR', 'SELFIE_RETAKE', 'OTHER');

-- AlterTable
ALTER TABLE "kyc_sessions" ADD COLUMN     "resubmitTypes" "DocumentType"[] DEFAULT ARRAY[]::"DocumentType"[],
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "officerId" UUID NOT NULL,
    "decision" "DecisionType" NOT NULL,
    "reasonCode" "ReasonCode",
    "reasonNote" TEXT,
    "resubmitDocumentTypes" "DocumentType"[] DEFAULT ARRAY[]::"DocumentType"[],
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "officer_assignments" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "officerId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "officer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_sessionId_createdAt_idx" ON "decisions"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "decisions_officerId_idx" ON "decisions"("officerId");

-- CreateIndex
CREATE INDEX "officer_assignments_sessionId_isActive_idx" ON "officer_assignments"("sessionId", "isActive");

-- CreateIndex
CREATE INDEX "officer_assignments_officerId_isActive_idx" ON "officer_assignments"("officerId", "isActive");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Backfill: the last time each existing session entered SUBMITTED, from the audit trail.
UPDATE "kyc_sessions" s
SET "submittedAt" = a.at
FROM (
  SELECT "entityId", max("createdAt") AS at
  FROM "audit_logs"
  WHERE "entityType" = 'KycSession'
    AND action = 'kyc.session.transitioned'
    AND metadata ->> 'to' = 'SUBMITTED'
  GROUP BY "entityId"
) a
WHERE a."entityId" = s.id::text;

-- At most one active assignment per session. This is what makes "claim" safe when two officers click at once.
CREATE UNIQUE INDEX "officer_assignments_one_active_per_session"
ON "officer_assignments"("sessionId")
WHERE "isActive";

-- A released assignment has a release time and an active one does not.
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_release_consistent"
CHECK (("isActive" AND "releasedAt" IS NULL) OR (NOT "isActive" AND "releasedAt" IS NOT NULL));

-- The controlled vocabulary, per decision type. The API checks the same lists; this is the backstop.
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_reason_matches_decision"
CHECK (
  ("decision" = 'APPROVE'
    AND "reasonCode" IS NULL
    AND COALESCE(cardinality("resubmitDocumentTypes"), 0) = 0)
  OR ("decision" = 'REJECT'
    AND "reasonCode" IS NOT NULL
    AND "reasonCode" IN ('IDENTITY_MISMATCH', 'DOCUMENT_TAMPERED', 'FACE_MISMATCH', 'DUPLICATE_IDENTITY', 'AGE_INELIGIBLE', 'OTHER')
    AND COALESCE(cardinality("resubmitDocumentTypes"), 0) = 0)
  OR ("decision" = 'REQUEST_RESUBMIT'
    AND "reasonCode" IS NOT NULL
    AND "reasonCode" IN ('POOR_IMAGE_QUALITY', 'WRONG_DOCUMENT', 'SIGNATURE_UNCLEAR', 'SELFIE_RETAKE', 'OTHER')
    AND COALESCE(cardinality("resubmitDocumentTypes"), 0) > 0)
);

-- decisions is append-only, like audit_logs and risk_assessments: what was decided, by whom, and on what evidence
-- must stay readable exactly as it was. TRUNCATE is deliberately not blocked.
CREATE OR REPLACE FUNCTION decisions_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decisions is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_no_update_delete
BEFORE UPDATE OR DELETE ON "decisions"
FOR EACH ROW EXECUTE FUNCTION decisions_block_mutation();
