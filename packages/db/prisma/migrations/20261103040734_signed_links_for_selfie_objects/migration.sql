-- AlterTable
ALTER TABLE "signed_url_issues" ADD COLUMN     "objectRef" TEXT,
ALTER COLUMN "documentId" DROP NOT NULL;

-- A link is to exactly one object: a document, or a selfie frame or crop.
ALTER TABLE "signed_url_issues"
ADD CONSTRAINT "signed_url_issues_one_target" CHECK (("documentId" IS NULL) <> ("objectRef" IS NULL));
