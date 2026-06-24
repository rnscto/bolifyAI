import { parse } from "https://deno.land/std@0.208.0/jsonc/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

const ENTITIES_DIR = "../../base44/entities";
const OUTPUT_FILE = "init.sql";

const typeMapping: Record<string, string> = {
  string: "TEXT",
  number: "NUMERIC",
  boolean: "BOOLEAN",
  array: "JSONB",
  object: "JSONB",
};

async function generateSchema() {
  const sqlStatements: string[] = [];
  sqlStatements.push(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  const updateFunctionSql = `
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';
`;
  sqlStatements.push(updateFunctionSql);

  for await (const dirEntry of Deno.readDir(ENTITIES_DIR)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".jsonc")) {
      const filePath = join(ENTITIES_DIR, dirEntry.name);
      const content = await Deno.readTextFile(filePath);
      let entity;
      try {
        entity = parse(content) as any;
      } catch (e) {
        console.error(`Failed to parse ${dirEntry.name}:`, e.message);
        continue;
      }

      const tableName = entity.name.toLowerCase();
      let createTableSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;
      createTableSql += `  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),\n`;
      createTableSql += `  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n`;
      createTableSql += `  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`;

      if (entity.properties) {
        for (const [colName, colDef] of Object.entries<any>(entity.properties)) {
          const pgType = typeMapping[colDef.type] || "TEXT";
          createTableSql += `,\n  "${colName}" ${pgType}`;
        }
      }

      // Automatically add auth fields to User table
      if (tableName === "user") {
        createTableSql += `,\n  "email" TEXT UNIQUE`;
        createTableSql += `,\n  "password_hash" TEXT`;
      }

      createTableSql += `\n);\n`;

      const triggerSql = `
DROP TRIGGER IF EXISTS update_${tableName}_updated_at ON "${tableName}";
CREATE TRIGGER update_${tableName}_updated_at
BEFORE UPDATE ON "${tableName}"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
`;
      
      sqlStatements.push(createTableSql);
      sqlStatements.push(triggerSql);
    }
  }

  await Deno.writeTextFile(OUTPUT_FILE, sqlStatements.join("\n"));
  console.log(`Generated SQL schema in ${OUTPUT_FILE}`);
}

if (import.meta.main) {
  generateSchema();
}
