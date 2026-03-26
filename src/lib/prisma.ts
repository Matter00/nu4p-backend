import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("crossover.proxy.rlwy.net:10450");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });