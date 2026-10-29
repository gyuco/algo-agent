-- AlterTable: a new project gets one at approval
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Mission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER,
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
    "baseCommit" TEXT,
    "branch" TEXT,
    "worktreePath" TEXT,
    "prUrl" TEXT,
    "waitJson" TEXT,
    "budgetJson" TEXT NOT NULL DEFAULT '{}',
    "progressJson" TEXT NOT NULL DEFAULT '{}',
    "newProjectJson" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "finishedAt" DATETIME,
    "seenAt" DATETIME,
    CONSTRAINT "Mission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Mission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Mission" ("id","projectId","userId","title","status","mode","input","planJson","planVersion","approvedVersion","orchestratorModel","sessionId","fromSession","baseBranch","baseCommit","branch","worktreePath","prUrl","waitJson","budgetJson","progressJson","costUsd","createdAt","updatedAt","approvedAt","finishedAt","seenAt") SELECT "id","projectId","userId","title","status","mode","input","planJson","planVersion","approvedVersion","orchestratorModel","sessionId","fromSession","baseBranch","baseCommit","branch","worktreePath","prUrl","waitJson","budgetJson","progressJson","costUsd","createdAt","updatedAt","approvedAt","finishedAt","seenAt" FROM "Mission";
DROP TABLE "Mission";
ALTER TABLE "new_Mission" RENAME TO "Mission";
CREATE INDEX "Mission_projectId_idx" ON "Mission"("projectId");
CREATE INDEX "Mission_userId_status_idx" ON "Mission"("userId", "status");
CREATE INDEX "Mission_sessionId_idx" ON "Mission"("sessionId");

-- AlterTable: the briefing run of a new project has no project
CREATE TABLE "new_WorkflowRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER,
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
    "purposeJson" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "specJson" TEXT,
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
INSERT INTO "new_WorkflowRun" ("id","projectId","userId","kind","status","trigger","title","input","workflow","workflowHash","sessionId","agent","model","effort","provider","writes","missionId","missionTaskId","purposeJson","stepsJson","specJson","costUsd","error","resumeOf","startedAt","heartbeatAt","finishedAt","seenAt","createdAt","updatedAt") SELECT "id","projectId","userId","kind","status","trigger","title","input","workflow","workflowHash","sessionId","agent","model","effort","provider","writes","missionId","missionTaskId","purposeJson","stepsJson","specJson","costUsd","error","resumeOf","startedAt","heartbeatAt","finishedAt","seenAt","createdAt","updatedAt" FROM "WorkflowRun";
DROP TABLE "WorkflowRun";
ALTER TABLE "new_WorkflowRun" RENAME TO "WorkflowRun";
CREATE INDEX "WorkflowRun_projectId_idx" ON "WorkflowRun"("projectId");
CREATE INDEX "WorkflowRun_status_createdAt_idx" ON "WorkflowRun"("status", "createdAt");
CREATE INDEX "WorkflowRun_userId_status_idx" ON "WorkflowRun"("userId", "status");
CREATE INDEX "WorkflowRun_sessionId_idx" ON "WorkflowRun"("sessionId");
CREATE INDEX "WorkflowRun_missionId_idx" ON "WorkflowRun"("missionId");
CREATE INDEX "WorkflowRun_missionTaskId_idx" ON "WorkflowRun"("missionTaskId");
PRAGMA foreign_keys=ON;
