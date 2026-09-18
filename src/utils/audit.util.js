import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Never let a logging failure break the actual admin action.
export async function logAuditAction({ actorId, actorName, action, targetType, target, details }) {
  try {
    await prisma.auditLog.create({
      data: { actorId, actorName, action, targetType, target, details },
    });
  } catch (err) {
    console.error('[Audit Log Error]', err);
  }
}
