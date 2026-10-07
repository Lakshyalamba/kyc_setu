-- CreateTable
CREATE TABLE "audit_chain_checkpoint" (
    "id" UUID NOT NULL,
    "chainDate" DATE NOT NULL,
    "startRowId" UUID NOT NULL,
    "endRowId" UUID NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "previousCheckpointHash" TEXT NOT NULL,
    "chainHash" TEXT NOT NULL,
    "rowHashes" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_chain_checkpoint_chainDate_key" ON "audit_chain_checkpoint"("chainDate");


-- Checkpoints are evidence: once written they are never changed or removed, like the audit log itself. (A superuser
-- can still switch a trigger off; the point of the chain is that the next verification notices anything done meanwhile.)
CREATE OR REPLACE FUNCTION audit_chain_checkpoint_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_chain_checkpoint is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_chain_checkpoint_no_update_delete
BEFORE UPDATE OR DELETE ON "audit_chain_checkpoint"
FOR EACH ROW EXECUTE FUNCTION audit_chain_checkpoint_block_mutation();

-- The hash and the bookkeeping must look like what the builder writes.
ALTER TABLE "audit_chain_checkpoint" ADD CONSTRAINT "audit_chain_checkpoint_shape"
CHECK ("chainHash" ~ '^[0-9a-f]{64}$' AND "previousCheckpointHash" ~ '^[0-9a-f]{64}$' AND "rowCount" > 0);
