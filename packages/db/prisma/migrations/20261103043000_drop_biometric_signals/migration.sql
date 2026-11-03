-- DropForeignKey
ALTER TABLE "biometric_signals" DROP CONSTRAINT "biometric_signals_sessionId_fkey";

-- DropTable
DROP TABLE "biometric_signals";

-- DropEnum
DROP TYPE "BiometricSource";

-- biometric_signals only ever held values written by the development injector, which is gone; the selfie, motion-check and face-match tables replace it.
