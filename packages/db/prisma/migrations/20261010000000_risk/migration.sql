-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RiskTrigger" AS ENUM ('AUTO', 'RECOMPUTE');

-- CreateEnum
CREATE TYPE "BiometricSource" AS ENUM ('PIPELINE', 'DEV_INJECTED');

-- CreateTable
CREATE TABLE "risk_assessments" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "RiskBand" NOT NULL,
    "rawBand" "RiskBand" NOT NULL,
    "hardFail" BOOLEAN NOT NULL,
    "triggeredRules" JSONB NOT NULL,
    "bandFloors" JSONB NOT NULL,
    "appliedRules" TEXT[],
    "skippedRules" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "inputsSnapshot" JSONB NOT NULL,
    "trigger" "RiskTrigger" NOT NULL,
    "triggeredById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_signals" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "source" "BiometricSource" NOT NULL,
    "faceMatchScore" DOUBLE PRECISION,
    "faceMatchModel" TEXT,
    "livenessPassed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "risk_assessments_sessionId_createdAt_idx" ON "risk_assessments"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "biometric_signals_sessionId_createdAt_idx" ON "biometric_signals"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_signals" ADD CONSTRAINT "biometric_signals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- risk_assessments is append-only, like audit_logs: history is the point (a historic score must stay
-- explainable by the engine version that produced it). TRUNCATE is deliberately not blocked.
CREATE OR REPLACE FUNCTION risk_assessments_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'risk_assessments is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_assessments_no_update_delete
BEFORE UPDATE OR DELETE ON "risk_assessments"
FOR EACH ROW EXECUTE FUNCTION risk_assessments_block_mutation();
