import { base44ORM as base44 } from "../db/orm.ts";

/**
 * Generates or regenerates a platform API authorization key for the client.
 * The key is stored on the Client entity and used for CRM API authentication.
 */
export default async function generateAuthKey(c: any) {
  try {
    const user = c.get('jwtPayload');
    if (!user) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    const { regenerate } = await c.req.json().catch(() => ({}));

    // Find client record
    let clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      clients = await base44.entities.Client.filter({ email: user.email });
    }
    if (clients.length === 0) {
      return c.json({ data: { error: 'No client account found' } }, 404);
    }

    const client = clients[0];

    // If already has a key and not regenerating, return masked existing key
    if (client.api_auth_key && !regenerate) {
       // We only store the hash, so we cannot return the raw key.
       // Return a masked placeholder so the UI knows a key exists.
      return c.json({ data: { success: true, api_auth_key: 'gwk_•••••••••••••••••••••••••••••••• (Hashed)' } });
    }

    // Generate a secure key: gwk_ + 40 hex chars
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const newKeyRaw = `gwk_${hex}`;

    // Hash the key using SHA-256 for secure storage
    const dataToHash = new TextEncoder().encode(newKeyRaw);
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataToHash);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const newKeyHashed = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Store the HASH in the database
    await base44.entities.Client.update(client.id, { api_auth_key: newKeyHashed });

    console.log(`[generateAuthKey] Key ${regenerate ? 'regenerated' : 'created'} (hashed) for client ${client.id}`);

    // Return the RAW key ONLY ONCE to the user
    return c.json({ data: { success: true, api_auth_key: newKeyRaw } });

  } catch (error: any) {
    console.error('[generateAuthKey] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}
