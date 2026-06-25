import { client } from "./index.ts";

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
    const vals = Object.values(data);
    const query = `INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders}) RETURNING *`;
    const res = await client.queryObject(query, vals);
    return res.rows[0];
  }

  async update(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    if (keys.length === 0) return await this.get(id);

    const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
    const vals = [id, ...Object.values(data)];
    const query = `UPDATE "${this.tableName}" SET ${setClauses} WHERE id = $1 RETURNING *`;
    const res = await client.queryObject(query, vals);
    return res.rows[0] || null;
  }

  async delete(id: string) {
    const res = await client.queryObject(`DELETE FROM "${this.tableName}" WHERE id = $1 RETURNING *`, [id]);
    return res.rows[0] || null;
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
