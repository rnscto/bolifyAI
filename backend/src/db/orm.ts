import { client } from "./index.ts";
import { broadcastEntityChange } from "../services/realtime.ts";

export class DBEntityWrapper {
  private tableName: string;

  constructor(entityName: string) {
    this.tableName = entityName.toLowerCase();
  }

  async get(id: string) {
    const res = await client.queryObject(`SELECT * FROM "${this.tableName}" WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] || null;
  }

  async filter(params: Record<string, any>, sortBy: string = "", limit: number = 100, skip: number = 0) {
    let query = `SELECT * FROM "${this.tableName}"`;
    const conditions: string[] = [];
    const args: any[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(params)) {
      if (value === null) {
        conditions.push(`"${key}" IS NULL`);
      } else {
        conditions.push(`"${key}" = $${paramIndex}`);
        args.push(value);
        paramIndex++;
      }
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    if (sortBy) {
      const order = sortBy.startsWith("-") ? "DESC" : "ASC";
      const field = sortBy.startsWith("-") ? sortBy.substring(1) : sortBy;
      query += ` ORDER BY "${field}" ${order}`;
    }

    query += ` LIMIT $${paramIndex}`;
    args.push(limit);
    paramIndex++;
    
    if (skip > 0) {
      query += ` OFFSET $${paramIndex}`;
      args.push(skip);
    }

    const res = await client.queryObject(query, args);
    return res.rows;
  }

  async create(data: Record<string, any>) {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      const res = await client.queryObject(`INSERT INTO "${this.tableName}" DEFAULT VALUES RETURNING *`);
      return res.rows[0];
    }
    const cols = keys.map(k => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const vals = Object.values(data).map(v => 
      (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
    );
    const query = `INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders}) RETURNING *`;
    const res = await client.queryObject(query, vals);
    const record = res.rows[0];
    if (record) broadcastEntityChange(this.tableName, "created", record);
    return record;
  }

  async update(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    if (keys.length === 0) return await this.get(id);

    let previousRecord = null;
    if (this.tableName === "client" && data.account_status) {
      previousRecord = await this.get(id);
    }

    const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
    const vals = [id, ...Object.values(data).map(v => 
      (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v
    )];
    const query = `UPDATE "${this.tableName}" SET ${setClauses} WHERE id = $1 RETURNING *`;
    const res = await client.queryObject(query, vals);
    const record = res.rows[0] || null;

    if (record && this.tableName === "client" && data.account_status && previousRecord && previousRecord.account_status !== data.account_status) {
      const eventType = data.account_status === "active" ? "activated" : (data.account_status === "expired" ? "trial_expired" : data.account_status);
      try {
        await base44ORM.entities.ClientLifecycleEvent.create({
          client_id: id,
          client_name: record.company_name,
          event_type: eventType,
          from_value: previousRecord.account_status,
          to_value: data.account_status,
          effective_date: new Date().toISOString()
        });
      } catch (e) {
        console.error("Failed to create ClientLifecycleEvent in ORM:", e);
      }
    }

    if (record) broadcastEntityChange(this.tableName, "updated", record);
    return record;
  }

  async delete(id: string) {
    const res = await client.queryObject(`DELETE FROM "${this.tableName}" WHERE id = $1 RETURNING *`, [id]);
    const record = res.rows[0] || null;
    if (record) broadcastEntityChange(this.tableName, "deleted", record);
    return record;
  }
}

// Global base44 proxy for backwards compatibility during migration
export const base44ORM = {
  entities: new Proxy({} as any, {
    get: (target, prop: string) => {
      if (!target[prop]) {
        target[prop] = new DBEntityWrapper(prop);
      }
      return target[prop];
    }
  })
};
