-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Resource" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "projectId" INTEGER,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "specJson" TEXT NOT NULL,
    "secretsEncrypted" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Resource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Resource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Resource" ("createdAt", "id", "key", "kind", "secretsEncrypted", "specJson", "updatedAt", "userId") SELECT "createdAt", "id", "key", "kind", "secretsEncrypted", "specJson", "updatedAt", "userId" FROM "Resource";
DROP TABLE "Resource";
ALTER TABLE "new_Resource" RENAME TO "Resource";
CREATE UNIQUE INDEX "Resource_userId_kind_key_key" ON "Resource"("userId", "kind", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
