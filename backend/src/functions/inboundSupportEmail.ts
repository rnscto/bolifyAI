import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Inbound email → ticket webhook (Resend Inbound or generic JSON POST).
// Expects:
//   POST body: { from, to, subject, text, html, message_id, in_reply_to, references, attachments? }
// Auth: shared secret in ?secret=... query param (set INBOUND_EMAIL_SECRET env var).
//
// Logic:
//   1. Look at In-Reply-To / References / subject for ticket_thread_id token (ticket-<token>@vaaniai.in)
//      OR ticket_number ([TKT-xxxxxx]) → reply to existing ticket
//   2. Otherwise create a new ticket with source='email'



// ── Auto-responder / bounce / loop detection ───────────────────────────
// Returns reason string if the email should be dropped (no ticket created/updated).
function detectAutoOrBounce(headers, fromEmail, subject) {
  const h = headers || {};
  const lc = (k) => (h[k] || h[k.toLowerCase()] || h[k.toUpperCase()] || '').toString().toLowerCase();
  if (lc('Auto-Submitted') && lc('Auto-Submitted') !== 'no') return 'auto-submitted';
  if (lc('X-Auto-Response-Suppress')) return 'auto-response-suppress';
  if (lc('Precedence') === 'bulk' || lc('Precedence') === 'auto_reply' || lc('Precedence') === 'junk') return 'bulk-precedence';
  if (lc('X-Autoreply') === 'yes' || lc('X-Autorespond')) return 'x-autoreply';
  // Common bounce patterns
  const f = (fromEmail || '').toLowerCase();
  if (/(mailer-daemon|postmaster|no[-]?reply|noreply|do[-]?not[-]?reply|bounces?@)/i.test(f)) return 'bounce-or-noreply';
  // Out-of-office subjects
  if (/^(auto(matic)?\s*reply|out of office|away from office|on vacation)/i.test(subject || '')) return 'ooo-subject';
  return null;
}

// ── AI category + priority classifier ──────────────────────────────────
async function classifyTicket(svc, subject, body) {
  try {
    const prompt = `You are a support ticket classifier. Classify the following incoming customer email into ONE category and a priority level.

Categories (pick exactly one):
- sales: pricing questions, demo requests, plan inquiries, partnership outreach
- technical: bugs, errors, things not working, API/integration issues, login problems
- billing: invoices, payments, refunds, subscription, GST, charges
- onboarding: setup help, getting started, training, account configuration
- general: anything else

Priority guidelines:
- urgent: production down, can't login, payment failed, security issue, angry customer threatening to leave
- high: blocking issue affecting daily work, missed SLA mentioned, escalation
- medium: standard request, normal issue
- low: minor question, feature request, FYI

Subject: ${subject}

Body:
${(body || '').substring(0, 2000)}

Respond with strict JSON: {"category": "...", "priority": "...", "reason": "<one short sentence>"}`;

    const res = await svc.functions.invoke('invokeAzureLLM', {
      prompt,
      response_json_schema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          priority: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    });
    const r = res?.data?.result;
    if (!r) return null;
    const validCats = ['sales', 'technical', 'billing', 'onboarding', 'general'];
    const validPris = ['low', 'medium', 'high', 'urgent'];
    return {
      category: validCats.includes(r.category) ? r.category : 'general',
      priority: validPris.includes(r.priority) ? r.priority : 'medium',
      reason: r.reason || ''
    };
  } catch (e) {
    console.error('classifyTicket failed:', e.message);
    return null;
  }
}

function extractThreadToken(headerVals) {
  const joined = (Array.isArray(headerVals) ? headerVals.join(' ') : (headerVals || '')).toString();
  const m = joined.match(/ticket-([a-f0-9]{8,})@/i);
  return m ? m[1] : null;
}
function extractTicketNumber(subject) {
  const m = (subject || '').match(/\bTKT-\d{4,}\b/);
  return m ? m[0] : null;
}
function stripQuoted(text) {
  if (!text) return '';
  // Cut at common reply separators
  const cuts = [
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nOn .+ wrote:/,
    /\n>+\s/,
    /\nFrom:.+\nSent:/i
  ];
  let cleaned = text;
  for (const re of cuts) {
    const i = cleaned.search(re);
    if (i > 0) cleaned = cleaned.substring(0, i);
  }
  return cleaned.trim();
}

export default async function inboundSupportEmail(c: any) {
  const req = c.req.raw || c.req;
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expected = Deno.env.get('INBOUND_EMAIL_SECRET');
    if (!expected || secret !== expected) {
      return c.json({ data: { error: 'Unauthorized' } }, 401);
    }

    // Parse body — handle JSON, form-encoded, or empty
    const contentType = (req.headers.get('content-type') || '').toLowerCase();
    const bodyText = await req.text();
    if (!bodyText) {
      // CloudMailin URL verification ping — respond OK so the webhook validates
      return c.json({ data: { success: true, message: 'Webhook reachable. Send a real email to test.' } });
    }
    let raw;
    if (contentType.includes('application/json')) {
      raw = JSON.parse(bodyText);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      // CloudMailin "Multipart" form posts
      const params = new URLSearchParams(bodyText);
      raw = Object.fromEntries(params.entries());
    } else {
      // Try JSON anyway
      try { raw = JSON.parse(bodyText); }
      catch { return c.json({ data: { error: `Unsupported content-type: ${contentType}. Use JSON (Normalized) format.` } }, 400); }
    }

    // Normalize CloudMailin payload (envelope + headers + plain/html) to flat shape
    const isCloudMailin = !!(raw.envelope || raw.plain || raw.reply_plain);
    const payload = isCloudMailin ? {
      from: raw.headers?.From || raw.envelope?.from || '',
      subject: raw.headers?.Subject || '(no subject)',
      text: raw.reply_plain || raw.plain || '',
      html: raw.html || '',
      message_id: raw.headers?.['Message-ID'] || raw.headers?.['Message-Id'] || '',
      in_reply_to: raw.headers?.['In-Reply-To'] || '',
      references: raw.headers?.References || '',
      attachments: (raw.attachments || []).map(a => ({
        name: a.file_name || a.filename || 'attachment',
        url: a.url || '',
        size_kb: Math.round((a.size || 0) / 1024)
      }))
    } : raw;

    const from = payload.from || payload.sender || '';
    const fromEmail = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
    const fromName = (from.match(/^"?([^"<]+)"?\s*</) || [null, ''])[1].trim();
    const subject = payload.subject || '(no subject)';
    const text = payload.text || '';
    const html = payload.html || '';
    const messageId = payload.message_id || payload.headers?.['message-id'] || '';
    const inReplyTo = payload.in_reply_to || payload.headers?.['in-reply-to'] || '';
    const references = payload.references || payload.headers?.['references'] || '';
    const attachments = payload.attachments || [];

    /* const base44 = ... */;
    const svc = base44.asServiceRole;

    // Drop auto-responders, bounces, out-of-office, and noreply senders to prevent ticket loops
    const dropReason = detectAutoOrBounce(payload.headers || raw.headers || {}, fromEmail, subject);
    if (dropReason) {
      console.log(`[inboundSupportEmail] Dropped email from ${fromEmail}: ${dropReason}`);
      return c.json({ data: { success: true, action: 'dropped', reason: dropReason } });
    }

    // Find existing ticket by thread token or ticket number
    const token = extractThreadToken(inReplyTo) || extractThreadToken(references);
    let ticket = null;
    if (token) {
      const list = await svc.entities.SupportTicket.filter({ email_thread_id: token });
      if (list.length) ticket = list[0];
    }
    if (!ticket) {
      const tNum = extractTicketNumber(subject);
      if (tNum) {
        const list = await svc.entities.SupportTicket.filter({ ticket_number: tNum });
        if (list.length) ticket = list[0];
      }
    }

    const cleanText = stripQuoted(text);

    if (ticket) {
      // Append reply
      await svc.entities.SupportTicketMessage.create({
        ticket_id: ticket.id,
        client_id: ticket.client_id || '',
        sender_type: 'customer',
        sender_email: fromEmail,
        sender_name: fromName,
        body_text: cleanText,
        body_html: html,
        channel: 'email',
        email_message_id: messageId,
        email_in_reply_to: inReplyTo,
        attachments,
        delivery_status: 'delivered'
      });
      const newIds = [...(ticket.email_message_ids || []), messageId].filter(Boolean).slice(-20);
      const updates = {
        last_message_at: new Date().toISOString(),
        last_message_by: 'customer',
        email_message_ids: newIds
      };
      if (['resolved', 'closed'].includes(ticket.status)) updates.status = 'reopened';
      else if (ticket.status === 'waiting_customer') updates.status = 'in_progress';
      await svc.entities.SupportTicket.update(ticket.id, updates);
      return c.json({ data: { success: true, action: 'reply_added', ticket_id: ticket.id } });
    }

    // AI-classify category and priority before creating ticket
    const classification = await classifyTicket(svc, subject, cleanText || text);
    const category = classification?.category || 'general';
    const priority = classification?.priority || 'medium';

    // Create new ticket via createSupportTicket invoke (consistent assignment logic)
    const res = await svc.functions.invoke('createSupportTicket', {
      subject,
      description: cleanText || text,
      category,
      priority,
      source: 'email',
      requester_email: fromEmail,
      requester_name: fromName,
      attachments
    });
    // Store first message id
    const newTicket = res?.data?.ticket;
    if (newTicket && messageId) {
      svc.entities.SupportTicket.update(newTicket.id, { email_message_ids: [messageId] }).catch(() => {});
    }
    return c.json({ data: { success: true, action: 'ticket_created', ticket: newTicket } });
  } catch (e) {
    console.error('inboundSupportEmail error:', e.message);
    return c.json({ data: { error: e.message } }, 500);
  }

};