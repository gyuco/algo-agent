-- AlterTable: a project can choose the colour of its icon or carry a logo
ALTER TABLE "Project" ADD COLUMN "color" TEXT;
ALTER TABLE "Project" ADD COLUMN "logo" TEXT;
