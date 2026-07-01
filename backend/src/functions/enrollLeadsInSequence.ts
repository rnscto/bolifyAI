import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


function computeDelayMs(value, unit) {
  const v = Number(value) || 0;
  if (unit === 'minutes') return v * 60 * 1000;
  if (unit === 'hours') return v * 60 * 60 * 1000;
  return v * 24 * 60 * 60 * 1000;
}

export default async function enrollLeadsInSequence(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;
    const user = c.get('jwtPayload');
    if (!user) return c.json({ data: { error: 'Unauthorized' } }, 401);

    const body = await c.req.json();
    const { sequence_id, lead_ids, use_group = false } = body;

    if (!sequence_id) return c.json({ data: { error: 'sequence_id required' } }, 400);

    const sequence = await base44.entities.LeadGroupSequence.get(sequence_id);
    if (!sequence) return c.json({ data: { error: 'Sequence not found' } }, 404);

    // Validate ownership
    const clients = await base44.entities.Client.filter({ user_id: user.id });
    const client = clients[0];
    if (!client || client.id !== sequence.client_id) {
      return c.json({ data: { error: 'Forbidden' } }, 403);
    }

    if (!sequence.steps || sequence.steps.length === 0) {
      return c.json({ data: { error: 'Sequence has no steps' } }, 400);
    }

    // Determine target leads
    let targetLeads = [];
    if (use_group) {
      const allLeads = await base44.entities.Lead.filter({ client_id: client.id }, '-created_date', 1000);
      targetLeads = allLeads.filter(l => (l.group_ids || []).includes(sequence.group_id));
    } else if (Array.isArray(lead_ids) && lead_ids.length > 0) {
      for (const id of lead_ids) {
        const l = await base44.entities.Lead.get(id).catch(() => null);
        if (l && l.client_id === client.id) targetLeads.push(l);
      }
    } else {
      return c.json({ data: { error: 'Provide lead_ids or set use_group=true' } }, 400);
    }

    // Check for existing active enrollments for these leads (avoid duplicates)
    const existingEnrollments = await base44.entities.LeadGroupSequenceEnrollment.filter({
      sequence_id,
      status: 'active'
    });
    const alreadyEnrolledIds = new Set(existingEnrollments.map(e => e.lead_id));

    const now = new Date();
    const firstStep = sequence.steps[0];
    const firstDelayMs = computeDelayMs(firstStep.delay_value, firstStep.delay_unit);

    const toCreate = [];
    let skipped = 0;
    for (const lead of targetLeads) {
      if (alreadyEnrolledIds.has(lead.id)) {
        skipped++;
        continue;
      }

      // Determine trigger date based on sequence config
      let triggerDate = now;
      if (sequence.trigger_type === 'after_screening_call' || sequence.trigger_type === 'after_last_call') {
        if (lead.last_call_date) {
          triggerDate = new Date(lead.last_call_date);
        }
      }

      const nextRun = new Date(triggerDate.getTime() + firstDelayMs);
      // If the calculated next run is in the past, fire it within the next minute
      const effectiveNextRun = nextRun < now ? new Date(now.getTime() + 60 * 1000) : nextRun;

      toCreate.push({
        client_id: client.id,
        sequence_id,
        group_id: sequence.group_id,
        lead_id: lead.id,
        status: 'active',
        current_step_index: 0,
        total_steps: sequence.steps.length,
        trigger_date: triggerDate.toISOString(),
        next_run_date: effectiveNextRun.toISOString(),
        execution_log: []
      });
    }

    if (toCreate.length > 0) {
      await base44.entities.LeadGroupSequenceEnrollment.bulkCreate(toCreate);
      await base44.entities.LeadGroupSequence.update(sequence_id, {
        total_enrolled: (sequence.total_enrolled || 0) + toCreate.length,
        status: sequence.status === 'draft' ? 'active' : sequence.status
      });
    }

    return c.json({ data: {
      success: true,
      enrolled: toCreate.length,
      skipped,
      total_targeted: targetLeads.length
    } });
  } catch (error) {
    console.error('enrollLeadsInSequence error', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};