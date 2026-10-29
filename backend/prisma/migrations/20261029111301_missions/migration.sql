-- CreateTable
CREATE TABLE "Mission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "planJson" TEXT,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "approvedVersion" INTEGER,
    "orchestratorModel" TEXT NOT NULL,
    "sessionId" TEXT,
    "fromSession" TEXT,
    "baseBranch" TEXT,
    "branch" TEXT,
    "worktreePath" TEXT,
    "prUrl" TEXT,
    "waitJson" TEXT,
    "budgetJson" TEXT NOT NULL DEFAULT '{}',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "finishedAt" DATETIME,
    "seenAt" DATETIME,
    CONSTRAINT "Mission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Mission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MissionTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "missionId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "branch" TEXT,
    "worktreePath" TEXT,
    "runId" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notesJson" TEXT NOT NULL DEFAULT '[]',
    "reportJson" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "MissionTask_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MissionEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "missionId" INTEGER NOT NULL,
    "taskId" INTEGER,
    "kind" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MissionEntry_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MissionEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "MissionTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
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
    "effort" TEXT,
    "provider" TEXT,
    "writes" BOOLEAN NOT NULL DEFAULT false,
    "missionId" INTEGER,
    "missionTaskId" INTEGER,
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
    CONSTRAINT "WorkflowRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_missionTaskId_fkey" FOREIGN KEY ("missionTaskId") REFERENCES "MissionTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WorkflowRun" ("agent", "costUsd", "createdAt", "effort", "error", "finishedAt", "heartbeatAt", "id", "input", "kind", "model", "projectId", "provider", "resumeOf", "seenAt", "sessionId", "startedAt", "status", "stepsJson", "title", "trigger", "updatedAt", "userId", "workflow", "workflowHash", "writes") SELECT "agent", "costUsd", "createdAt", "effort", "error", "finishedAt", "heartbeatAt", "id", "input", "kind", "model", "projectId", "provider", "resumeOf", "seenAt", "sessionId", "startedAt", "status", "stepsJson", "title", "trigger", "updatedAt", "userId", "workflow", "workflowHash", "writes" FROM "WorkflowRun";
DROP TABLE "WorkflowRun";
ALTER TABLE "new_WorkflowRun" RENAME TO "WorkflowRun";
CREATE INDEX "WorkflowRun_projectId_idx" ON "WorkflowRun"("projectId");
CREATE INDEX "WorkflowRun_status_createdAt_idx" ON "WorkflowRun"("status", "createdAt");
CREATE INDEX "WorkflowRun_userId_status_idx" ON "WorkflowRun"("userId", "status");
CREATE INDEX "WorkflowRun_sessionId_idx" ON "WorkflowRun"("sessionId");
CREATE INDEX "WorkflowRun_missionId_idx" ON "WorkflowRun"("missionId");
CREATE INDEX "WorkflowRun_missionTaskId_idx" ON "WorkflowRun"("missionTaskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Mission_projectId_idx" ON "Mission"("projectId");

-- CreateIndex
CREATE INDEX "Mission_userId_status_idx" ON "Mission"("userId", "status");

-- CreateIndex
CREATE INDEX "Mission_sessionId_idx" ON "Mission"("sessionId");

-- CreateIndex
CREATE INDEX "MissionTask_missionId_idx" ON "MissionTask"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionTask_missionId_key_key" ON "MissionTask"("missionId", "key");

-- CreateIndex
CREATE INDEX "MissionEntry_missionId_idx" ON "MissionEntry"("missionId");
