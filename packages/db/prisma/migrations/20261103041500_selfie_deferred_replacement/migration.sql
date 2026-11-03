-- DropIndex
DROP INDEX "face_matches_selfieCaptureId_key";

-- AlterTable
ALTER TABLE "selfie_captures" ADD COLUMN     "confirmedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "face_matches_selfieCaptureId_idDocumentId_key" ON "face_matches"("selfieCaptureId", "idDocumentId");


-- Replacing a selfie sets the OLD row's replacedById to the NEW row's id before the new row exists in the same
-- transaction (the unique "one active per session" index forces that order), so this foreign key is checked at commit.
ALTER TABLE "selfie_captures" DROP CONSTRAINT "selfie_captures_replacedById_fkey";
ALTER TABLE "selfie_captures"
ADD CONSTRAINT "selfie_captures_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "selfie_captures"("id")
ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
