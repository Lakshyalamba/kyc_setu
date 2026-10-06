-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE');

-- CreateEnum
CREATE TYPE "SignedUrlPurpose" AS ENUM ('CUSTOMER_PREVIEW', 'OFFICER_REVIEW');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedById" UUID,
    "encryptedDataKey" BYTEA NOT NULL,
    "kmsKeyId" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signed_url_issues" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "issuedToUserId" UUID NOT NULL,
    "purpose" "SignedUrlPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signed_url_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_sessionId_type_idx" ON "documents"("sessionId", "type");

-- CreateIndex
CREATE INDEX "signed_url_issues_documentId_idx" ON "signed_url_issues"("documentId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "kyc_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "signed_url_issues" ADD CONSTRAINT "signed_url_issues_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signed_url_issues" ADD CONSTRAINT "signed_url_issues_issuedToUserId_fkey" FOREIGN KEY ("issuedToUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Only one ACTIVE document per type per session. Replacing sets the old row's replacedById first
-- (the self-FK above is deferred so it may point at a row inserted later in the same transaction).
CREATE UNIQUE INDEX "documents_one_active_per_type"
ON "documents"("sessionId", "type")
WHERE "replacedById" IS NULL;
