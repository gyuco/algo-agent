import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client.js';

const email = (process.env.SEED_EMAIL ?? 'test@algo-agent.local').toLowerCase();
const password =
  process.env.SEED_PASSWORD ?? randomBytes(9).toString('base64url');

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }),
});

const passwordHash = await bcrypt.hash(password, 12);
await prisma.user.upsert({
  where: { email },
  update: { passwordHash },
  create: { email, passwordHash },
});
await prisma.$disconnect();

console.log(`Seeded user: ${email} / ${password}`);
