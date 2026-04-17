import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { action, client_id, data } = body;

    // List all clients
    if (!action || action === 'list') {
      const [clients, users] = await Promise.all([
        base44.asServiceRole.entities.Client.list('-created_date'),
        base44.asServiceRole.entities.User.list()
      ]);
      return Response.json({ clients, users });
    }

    // Create client
    if (action === 'create') {
      const client = await base44.asServiceRole.entities.Client.create(data);
      return Response.json({ client });
    }

    // Update client
    if (action === 'update' && client_id) {
      await base44.asServiceRole.entities.Client.update(client_id, data);
      return Response.json({ success: true });
    }

    // Delete client
    if (action === 'delete' && client_id) {
      await base44.asServiceRole.entities.Client.delete(client_id);
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[adminListClients] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});