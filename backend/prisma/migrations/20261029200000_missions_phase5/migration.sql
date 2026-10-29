-- AlterTable
ALTER TABLE "Mission" ADD COLUMN "progressJson" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "purposeJson" TEXT;
