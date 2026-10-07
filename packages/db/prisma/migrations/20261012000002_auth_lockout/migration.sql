-- CreateTable
CREATE TABLE "auth_lockouts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL,
    "unlockedAt" TIMESTAMP(3),
    "unlockedById" UUID,

    CONSTRAINT "auth_lockouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_lockouts_userId_lockedUntil_idx" ON "auth_lockouts"("userId", "lockedUntil");

-- AddForeignKey
ALTER TABLE "auth_lockouts" ADD CONSTRAINT "auth_lockouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

