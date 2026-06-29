import { expandGlob } from "https://deno.land/std@0.208.0/fs/expand_glob.ts";

async function readTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

async function runAudit() {
  const errors = [];
  const warnings = [];
  
  // 1. Gather all base44 entities
  const entities = [];
  for await (const file of expandGlob("base44/entities/*.jsonc")) {
    const entityName = file.name.replace(".jsonc", "");
    entities.push(entityName);
  }
  
  // 2. Check backend/src/controllers/v1.ts
  const v1Content = await readTextFile("backend/src/controllers/v1.ts");
  for (const entity of entities) {
    // looking for something like buildCrudRouter("entityName" lowercase)
    const lower = entity.toLowerCase();
    if (!v1Content.includes(`buildCrudRouter("${lower}")`)) {
      errors.push(`[v1.ts] Missing route registration for entity: ${entity}.jsonc (expected buildCrudRouter("${lower}"))`);
    }
  }

  // 3. Check src/api/apiClient.js
  const apiContent = await readTextFile("src/api/apiClient.js");
  for (const entity of entities) {
    // looking for something like new EntityClient('/v1/entities', 'entityName' lowercase)
    const lower = entity.toLowerCase();
    if (!apiContent.includes(`new EntityClient(`) || !apiContent.toLowerCase().includes(`'${lower}'`)) {
      errors.push(`[apiClient.js] Missing frontend EntityClient for: ${entity}.jsonc`);
    }
  }

  console.log("----- BASE44 AUDIT REPORT -----");
  if (errors.length === 0) {
    console.log("✅ All entities are perfectly mapped in v1.ts and apiClient.js");
  } else {
    console.log(`❌ Found ${errors.length} integrity errors:\n`);
    errors.forEach(e => console.log(e));
  }
}

runAudit();
