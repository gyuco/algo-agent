-- CreateTable
CREATE TABLE "RunEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkflowRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'workflow',
    "status" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "title" TEXT NOT NULL DEFAULT '',
    "input" TEXT NOT NULL,
    "workflow" TEXT,
    "workflowHash" TEXT,
    "sessionId" TEXT,
    "agent" TEXT,
    "model" TEXT,
    "provider" TEXT,
    "writes" BOOLEAN NOT NULL DEFAULT false,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "error" TEXT,
    "resumeOf" INTEGER,
    "startedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "finishedAt" DATETIME,
    "seenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Existing runs are workflow runs: their user is the project's owner.
INSERT INTO "new_WorkflowRun" ("createdAt", "id", "input", "projectId", "userId", "title", "status", "stepsJson", "updatedAt", "workflow", "finishedAt")
SELECT r."createdAt", r."id", r."input", r."projectId", p."userId", r."workflow", r."status", r."stepsJson", r."updatedAt", r."workflow",
       CASE WHEN r."status" = 'running' THEN NULL ELSE r."updatedAt" END
FROM "WorkflowRun" r JOIN "Project" p ON p."id" = r."projectId";
DROP TABLE "WorkflowRun";
ALTER TABLE "new_WorkflowRun" RENAME TO "WorkflowRun";
CREATE INDEX "WorkflowRun_projectId_idx" ON "WorkflowRun"("projectId");
CREATE INDEX "WorkflowRun_status_createdAt_idx" ON "WorkflowRun"("status", "createdAt");
CREATE INDEX "WorkflowRun_userId_status_idx" ON "WorkflowRun"("userId", "status");
CREATE INDEX "WorkflowRun_sessionId_idx" ON "WorkflowRun"("sessionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_seq_key" ON "RunEvent"("runId", "seq");
