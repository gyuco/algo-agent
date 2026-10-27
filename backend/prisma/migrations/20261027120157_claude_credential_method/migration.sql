-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClaudeCredential" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClaudeCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Existing rows are all API keys: carry them over under the new column names.
INSERT INTO "new_ClaudeCredential" ("createdAt", "id", "updatedAt", "userId", "method", "secretEncrypted", "secretHint") SELECT "createdAt", "id", "updatedAt", "userId", 'api_key', "apiKeyEncrypted", "apiKeyHint" FROM "ClaudeCredential";
DROP TABLE "ClaudeCredential";
ALTER TABLE "new_ClaudeCredential" RENAME TO "ClaudeCredential";
CREATE UNIQUE INDEX "ClaudeCredential_userId_key" ON "ClaudeCredential"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
