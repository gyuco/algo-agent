-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "secretEncrypted" TEXT,
    "secretHint" TEXT,
    "stateJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_userId_provider_key" ON "ProviderConnection"("userId", "provider");

-- Claude credentials become "claude" connections; the rate-limit snapshot moves into stateJson.
INSERT INTO "ProviderConnection" ("userId", "provider", "method", "secretEncrypted", "secretHint", "stateJson", "createdAt", "updatedAt")
SELECT "userId", 'claude', "method", "secretEncrypted", "secretHint",
       CASE WHEN "rateLimitJson" IS NULL THEN NULL ELSE json_object('rateLimits', json("rateLimitJson")) END,
       "createdAt", "updatedAt"
FROM "ClaudeCredential";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ClaudeCredential";
PRAGMA foreign_keys=on;
