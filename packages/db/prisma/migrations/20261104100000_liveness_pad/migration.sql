-- Passive anti-spoofing next to the motion check. Existing rows keep method MOTION_CHECK and get null PAD columns: no data moves.

-- AlterEnum
ALTER TYPE "LivenessMethod" ADD VALUE 'PASSIVE_PAD';
ALTER TYPE "LivenessMethod" ADD VALUE 'PASSIVE_PLUS_MOTION';

-- AlterEnum
ALTER TYPE "LivenessFailureReason" ADD VALUE 'PAD_SPOOF';
ALTER TYPE "LivenessFailureReason" ADD VALUE 'PAD_UNAVAILABLE';

-- CreateEnum
CREATE TYPE "PadDecision" AS ENUM ('LIVE', 'BORDERLINE', 'SPOOF', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "liveness_results"
  ADD COLUMN "padScore" DOUBLE PRECISION,
  ADD COLUMN "padThreshold" DOUBLE PRECISION,
  ADD COLUMN "padFailThreshold" DOUBLE PRECISION,
  ADD COLUMN "padDecision" "PadDecision",
  ADD COLUMN "subScores" JSONB,
  ADD COLUMN "modelWeightsHash" TEXT;
