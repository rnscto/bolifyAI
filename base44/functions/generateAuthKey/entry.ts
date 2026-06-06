import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Generates or regenerates a platform API authorization key for the client.
 * The key is stored on the Client entity and used for CRM API authentication.
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { regenerate } = await req.json().catch(() => ({}));

    // Find client record
    let clients = await base44.entities.Client.filter({ user_id: user.id });
    if (clients.length === 0) {
      clients = await base44.entities.Client.filter({ email: user.email });
    }
    if (clients.length === 0) {
      return Response.json({ error: 'No client account found' }, { status: 404 });
    }

    const client = clients[0];

    // If already has a key and not regenerating, return existing
    if (client.api_auth_key && !regenerate) {
      return Response.json({ success: true, api_auth_key: client.api_auth_key });
    }

    // Generate a secure key: gwk_ + 40 hex chars
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const newKey = `gwk_${hex}`;

    await base44.entities.Client.update(client.id, { api_auth_key: newKey });

    console.log(`[generateAuthKey] Key ${regenerate ? 'regenerated' : 'created'} for client ${client.id}`);

    return Response.json({ success: true, api_auth_key: newKey });

  } catch (error) {
    console.error('[generateAuthKey] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});