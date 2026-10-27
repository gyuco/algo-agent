-- AlterTable
ALTER TABLE "ClaudeCredential" ADD COLUMN "rateLimitAt" DATETIME;
ALTER TABLE "ClaudeCredential" ADD COLUMN "rateLimitJson" TEXT;
