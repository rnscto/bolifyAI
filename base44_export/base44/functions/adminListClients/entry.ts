import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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
      const [clients, users, activations] = await Promise.all([
        base44.asServiceRole.entities.Client.list('-created_at'),
        base44.asServiceRole.entities.User.list(),
        base44.asServiceRole.entities.ClientLifecycleEvent.filter({ event_type: 'activated' }, 'effective_date', 2000)
      ]);
      // Map each client to its earliest activation (paid) date
      const activationByClient = {};
      for (const ev of activations) {
        const d = ev.effective_date || ev.created_at;
        if (!d) continue;
        if (!activationByClient[ev.client_id] || new Date(d) < new Date(activationByClient[ev.client_id])) {
          activationByClient[ev.client_id] = d;
        }
      }
      const enriched = clients.map(c => ({ ...c, activation_date: activationByClient[c.id] || null }));
      return Response.json({ clients: enriched, users });
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