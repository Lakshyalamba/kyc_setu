-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'SERVICE');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'OK', 'LOW_QUALITY', 'PARSE_FAILED', 'WRONG_DOCUMENT', 'ERROR', 'SKIPPED');

-- AlterEnum
ALTER TYPE "KycStatus" ADD VALUE 'DOCS_EXTRACTED';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'AI_SERVICE';

-- AlterEnum
ALTER TYPE "SignedUrlPurpose" ADD VALUE 'AI_INTERNAL';

-- AlterTable
ALTER TABLE "kyc_sessions" ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" "UserKind" NOT NULL DEFAULT 'HUMAN';

-- CreateTable
CREATE TABLE "extractions" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "fields" JSONB,
    "qualityMetrics" JSONB,
    "modelVersions" JSONB,
    "timings" JSONB,
    "rawTextEncrypted" BYTEA,
    "encryptedDataKey" BYTEA,
    "kmsKeyId" TEXT,
    "iv" BYTEA,
    "authTag" BYTEA,
    "panNumberHmac" TEXT,
    "aadhaarNumberLast4" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "extractions_documentId_key" ON "extractions"("documentId");

-- CreateIndex
CREATE INDEX "extractions_panNumberHmac_idx" ON "extractions"("panNumberHmac");

-- CreateIndex
CREATE INDEX "extractions_aadhaarNumberLast4_idx" ON "extractions"("aadhaarNumberLast4");

-- CreateIndex
CREATE INDEX "extractions_status_idx" ON "extractions"("status");

-- AddForeignKey
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

