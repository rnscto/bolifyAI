import { client } from "../db/index.ts";

/**
 * Write an entry to the auditlog table.
 * Errors are swallowed so audit failures never break the main action.
 */
export async function writeAuditLog({
  client_id,
  action_type,
  entity_type,
  entity_id,
  actor_email,
  actor_role,
  details,
  metadata,
  ip_address,
}: {
  client_id?: string;
  action_type: string;
  entity_type: string;
  entity_id?: string;
  actor_email?: string;
  actor_role?: string;
  details?: string;
  metadata?: Record<string, any>;
  ip_address?: string;
}) {
  try {
    await client.queryObject(
      `INSERT INTO "auditlog" 
        (client_id, action_type, entity_type, entity_id, actor_email, actor_role, details, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        client_id || null,
        action_type,
        entity_type,
        entity_id || null,
        actor_email || null,
        actor_role || null,
        details || null,
        metadata ? JSON.stringify(metadata) : null,
        ip_address || null,
      ]
    );
  } catch (err: any) {
    // Never throw — audit logging must not disrupt business operations
    console.error(`[auditLog] Failed to write audit entry: ${err.message}`);
  }
}
