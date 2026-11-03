-- CreateEnum
CREATE TYPE "LivenessMethod" AS ENUM ('MOTION_CHECK', 'NONE');

-- CreateEnum
CREATE TYPE "LivenessOutcome" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "LivenessFailureReason" AS ENUM ('FRAMES_TOO_SIMILAR', 'NO_FACE_IN_FRAME', 'FACE_MOVED_OUT', 'QUALITY_TOO_LOW');

-- CreateEnum
CREATE TYPE "FaceMatchDecision" AS ENUM ('AUTO_PASS', 'REVIEW', 'AUTO_FAIL');

-- CreateTable
CREATE TABLE "selfie_captures" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "framesStorageKeys" TEXT[],
    "bestFrameKey" TEXT NOT NULL,
    "frameEnvelopes" JSONB NOT NULL,
    "livenessMethod" "LivenessMethod" NOT NULL DEFAULT 'MOTION_CHECK',
    "deviceMeta" JSONB NOT NULL DEFAULT '{}',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedById" UUID,

    CONSTRAINT "selfie_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liveness_results" (
    "id" UUID NOT NULL,
    "selfieCaptureId" UUID NOT NULL,
    "method" "LivenessMethod" NOT NULL DEFAULT 'MOTION_CHECK',
    "result" "LivenessOutcome" NOT NULL,
    "failureReason" "LivenessFailureReason",
    "metrics" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liveness_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_matches" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "selfieCaptureId" UUID NOT NULL,
    "idDocumentId" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "failThreshold" DOUBLE PRECISION NOT NULL,
    "decision" "FaceMatchDecision" NOT NULL,
    "reason" TEXT,
    "embeddingVersion" TEXT NOT NULL,
    "selfieEmbedding" BYTEA,
    "idEmbedding" BYTEA,
    "idFaceCropKey" TEXT,
    "selfieFaceCropKey" TEXT,
    "cropEnvelopes" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "selfie_captures_replacedById_key" ON "selfie_captures"("replacedById");

-- CreateIndex
CREATE INDEX "selfie_captures_sessionId_capturedAt_idx" ON "selfie_captures"("sessionId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "liveness_results_selfieCaptureId_key" ON "liveness_results"("selfieCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "face_matches_selfieCaptureId_key" ON "face_matches"("selfieCaptureId");

-- CreateIndex
CREATE INDEX "face_matches_sessionId_computedAt_idx" ON "face_matches"("sessionId", "computedAt");

-- AddForeignKey
ALTER TABLE "selfie_captures" ADD CONSTRAINT "selfie_captures_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selfie_captures" ADD CONSTRAINT "selfie_captures_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "selfie_captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liveness_results" ADD CONSTRAINT "liveness_results_selfieCaptureId_fkey" FOREIGN KEY ("selfieCaptureId") REFERENCES "selfie_captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_matches" ADD CONSTRAINT "face_matches_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_matches" ADD CONSTRAINT "face_matches_selfieCaptureId_fkey" FOREIGN KEY ("selfieCaptureId") REFERENCES "selfie_captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_matches" ADD CONSTRAINT "face_matches_idDocumentId_fkey" FOREIGN KEY ("idDocumentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only one ACTIVE selfie per session. A retake sets the old row's replacedById first, then the new row is the only one without.
CREATE UNIQUE INDEX "selfie_captures_one_active_per_session"
ON "selfie_captures"("sessionId")
WHERE "replacedById" IS NULL;

-- A face match always lies in 0..1, and its two boundaries are ordered.
ALTER TABLE "face_matches"
ADD CONSTRAINT "face_matches_score_range" CHECK ("score" >= 0 AND "score" <= 1),
ADD CONSTRAINT "face_matches_thresholds_ordered" CHECK ("failThreshold" <= "threshold");
