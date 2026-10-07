-- CreateEnum
CREATE TYPE "AuditExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "audit_exports" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "status" "AuditExportStatus" NOT NULL DEFAULT 'QUEUED',
    "objectKey" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "audit_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_exports_sessionId_createdAt_idx" ON "audit_exports"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_exports_requestedById_idx" ON "audit_exports"("requestedById");

-- AddForeignKey
ALTER TABLE "audit_exports" ADD CONSTRAINT "audit_exports_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

