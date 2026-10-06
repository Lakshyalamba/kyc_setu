-- CreateEnum
CREATE TYPE "KycStep" AS ENUM ('CONTACT', 'CONSENT', 'PERSONAL', 'DOCUMENTS', 'SELFIE', 'REVIEW');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'EMAIL');

-- AlterEnum
BEGIN;
CREATE TYPE "KycStatus_new" AS ENUM ('DRAFT', 'CONSENT_GIVEN', 'PERSONAL_SUBMITTED', 'DOCS_UPLOADED', 'SELFIE_CAPTURED', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RESUBMIT_REQUESTED', 'EXPIRED');
ALTER TABLE "public"."kyc_sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "kyc_sessions" ALTER COLUMN "status" TYPE "KycStatus_new" USING (
  CASE "status"::text
    WHEN 'DETAILS_SUBMITTED' THEN 'PERSONAL_SUBMITTED'
    WHEN 'DOCUMENTS_UPLOADED' THEN 'DOCS_UPLOADED'
    ELSE "status"::text -- SIGNATURE_CAPTURED / AI_PROCESSING were never used and are removed
  END
)::"KycStatus_new";
ALTER TYPE "KycStatus" RENAME TO "KycStatus_old";
ALTER TYPE "KycStatus_new" RENAME TO "KycStatus";
DROP TYPE "public"."KycStatus_old";
ALTER TABLE "kyc_sessions" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
ALTER TABLE "kyc_sessions" ADD COLUMN     "completedSteps" "KycStep"[] DEFAULT ARRAY[]::"KycStep"[],
ADD COLUMN     "consentAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "consentVersionId" UUID,
ADD COLUMN     "currentStep" "KycStep" NOT NULL DEFAULT 'CONTACT',
ADD COLUMN     "personalDetails" JSONB;

-- CreateTable
CREATE TABLE "consent_versions" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "destination" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consent_versions_version_key" ON "consent_versions"("version");

-- CreateIndex
CREATE INDEX "otp_challenges_userId_createdAt_idx" ON "otp_challenges"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "otp_challenges_sessionId_idx" ON "otp_challenges"("sessionId");

-- AddForeignKey
ALTER TABLE "kyc_sessions" ADD CONSTRAINT "kyc_sessions_consentVersionId_fkey" FOREIGN KEY ("consentVersionId") REFERENCES "consent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One active (non-terminal) KYC session per user. Prisma can't model partial indexes.
CREATE UNIQUE INDEX "kyc_sessions_one_active_per_user"
ON "kyc_sessions"("userId")
WHERE "status" NOT IN ('APPROVED', 'REJECTED', 'EXPIRED');
