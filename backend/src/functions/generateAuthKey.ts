import { base44ORM as base44 } from "../db/orm.ts";

/**
 * Generates or regenerates a platform API authorization key for the client.
 * The key is stored on the Client entity and used for CRM API authentication.
 */
export default async function generateAuthKey(c: any) {
  try {
    const user = c.get('user');
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

    // If already has a key and not regenerating, return existing
    if (client.api_auth_key && !regenerate) {
      return c.json({ data: { success: true, api_auth_key: client.api_auth_key } });
    }

    // Generate a secure key: gwk_ + 40 hex chars
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const newKey = `gwk_${hex}`;

    await base44.entities.Client.update(client.id, { api_auth_key: newKey });

    console.log(`[generateAuthKey] Key ${regenerate ? 'regenerated' : 'created'} for client ${client.id}`);

    return c.json({ data: { success: true, api_auth_key: newKey } });

  } catch (error: any) {
    console.error('[generateAuthKey] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }
}
