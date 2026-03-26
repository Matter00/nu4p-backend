import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("postgresql://postgres:HJYpuUKXFmqaUzvjnsvtAdsOHanuYKTP@postgres.railway.internal:5432/railway");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });