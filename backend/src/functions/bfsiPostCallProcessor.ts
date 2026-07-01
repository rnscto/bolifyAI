import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";


/**
 * Entity automation triggered on CallLog terminal status updates.
 * Runs IN PARALLEL with campaignPostCall — non-destructive.
 *
 * Only acts when:
 *   - The CallLog belongs to a BFSI campaign (notes starts with "BFSI:")
 *   - OR the linked Agent has metadata.bfsi_case_type set
 *
 * Actions:
 *   1. Writes CollectionAttempt (for collections/bounce/settlement/legal)
 *   2. Updates VerificationCase or ReferenceCheck (for TVR / RCU)
 *   3. Auto-fires logBfsiCompliance (consent + abusive-language + retention)
 *   4. Adds borrower to BFSI DNC if outcome === 'do_not_call'
 *   5. Sends WhatsApp payment link on ptp / paid_now (via existing dispatchPostCallWhatsApp)
 *
 * Idempotent — uses `metadata.bfsi_post_processed` flag on the CallLog.
 */

const TERMINAL = new Set(['completed', 'failed', 'no_answer']);

// ─── Minimal regex extractors over the transcript ───
function extractOutcome(transcript, summary, defaultOutcome) {
  const blob = `${summary || ''}\n${transcript || ''}`.toLowerCase();
  if (/\bdo not call|don'?t call (me|again)|hata do (mera|number)|remove (me|my number)/i.test(blob)) return 'do_not_call';
  if (/\babus|gali|gaali|m[ae]derch|bhencho|bhenchod|chutiy|madarc/i.test(blob)) return 'abusive';
  if (/\bpaid (already|kar diya|kar di hai)|pay kar chuka|already paid/i.test(blob)) return 'already_paid';
  if (/\bdispute|galat|wrong charge|nahi liya|i did not take/i.test(blob)) return 'dispute';
  if (/\bdeceased|expired|guzar gaya|nahi rahe/i.test(blob)) return 'deceased';
  if (/\bwrong number|galat number/i.test(blob)) return 'wrong_number';
  if (/\bcall (me )?back|baad mein|later/i.test(blob)) return 'request_callback';
  if (/\bhuman|agent se|representative|manager se/i.test(blob)) return 'request_human';
  if (/\bptp|promise to pay|pay (karunga|karenge|by|on)|kal pay|paisa bhej|will pay/i.test(blob)) return 'ptp';
  if (/\bpaying now|abhi pay|abhi bhej raha/i.test(blob)) return 'paid_now';
  return defaultOutcome || 'other';
}

function extractPtpDate(text) {
  if (!text) return null;
  // Catches "by 25 June", "on 2026-06-25", "kal", "parso"
  const m = text.match(/by\s+(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{4})?/i);
  if (m) {
    const day = parseInt(m[1]);
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mon = months.indexOf(m[2].toLowerCase().slice(0,3));
    const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    return new Date(year, mon, day).toISOString().slice(0,10);
  }
  return null;
}

function extractPtpAmount(text) {
  if (!text) return null;
  const m = text.match(/(?:₹|rs\.?|inr|rupees?)\s*([0-9,]+)/i) || text.match(/([0-9]{4,7})\s*(rupees?|rs)/i);
  return m ? parseInt(m[1].replace(/[^0-9]/g, '')) : null;
}

export default async function bfsiPostCallProcessor(c: any) {
  const req = c.req.raw || c.req;
  try {
    const client = base44;;
    const base44 = client.asServiceRole;
    const payload = await c.req.json();
    const { event, data } = payload;

    if (!event || event.entity_name !== 'CallLog') {
      return c.json({ data: { success: true, skipped: 'not_call_log' } });
    }
    if (!TERMINAL.has(data.status)) {
      return c.json({ data: { success: true, skipped: 'not_terminal' } });
    }

    const callLogId = event.entity_id;
    const callLog = data;

    // Idempotency
    const meta = callLog.agent_config_cache?.bfsi_post_processed || callLog.transferred_to === 'bfsi_processed';
    if (meta) return c.json({ data: { success: true, skipped: 'already_processed' } });

    // Resolve agent + case type
    const agent = await base44.entities.Agent.get(callLog.agent_id).catch(() => null);
    let caseType = agent?.metadata?.bfsi_case_type || null;
    let campaign = null;

    // Try campaign route
    const campaignLeads = await base44.entities.CampaignLead.filter({ call_log_id: callLogId });
    if (campaignLeads.length > 0) {
      campaign = await base44.entities.Campaign.get(campaignLeads[0].campaign_id).catch(() => null);
      if (campaign?.notes?.startsWith('BFSI:')) {
        // notes like "BFSI:soft_collections • compliance gate ON • case_type=collection"
        const m = campaign.notes.match(/case_type=([a-z_]+)/i);
        if (m) caseType = m[1];
      }
    }

    if (!caseType) {
      return c.json({ data: { success: true, skipped: 'not_bfsi' } });
    }

    const campaignLead = campaignLeads[0] || null;
    const transcript = callLog.transcript || '';
    const summary = callLog.conversation_summary || '';
    const fallback = callLog.status === 'no_answer' ? 'no_answer' : 'other';
    const outcome = extractOutcome(transcript, summary, fallback);

    let collectionAttemptId = null;
    let verificationStatus = null;

    // ─── COLLECTIONS / BOUNCE / SETTLEMENT / LEGAL ───
    if (['collection', 'mandate_bounce', 'legal'].includes(caseType)) {
      // Determine loan account id — for BFSI campaigns we store LoanAccount.id in lead_id
      const loanAccountId = campaignLead?.lead_id || null;
      const loanAccount = loanAccountId
        ? await base44.entities.LoanAccount.get(loanAccountId).catch(() => null)
        : null;

      const ptpDate = extractPtpDate(transcript) || extractPtpDate(summary);
      const ptpAmount = extractPtpAmount(transcript) || extractPtpAmount(summary);

      const attempt = await base44.entities.CollectionAttempt.create({
        client_id: callLog.client_id,
        loan_account_id: loanAccountId,
        call_log_id: callLogId,
        campaign_id: campaign?.id || null,
        attempt_number: (loanAccount?.total_attempts || 0) + 1,
        bucket_at_time: loanAccount?.bucket || null,
        dpd_at_time: loanAccount?.dpd_days || null,
        outcome,
        ptp_date: ptpDate,
        ptp_amount: ptpAmount,
        ai_summary: summary.slice(0, 1000),
        transcript_excerpt: transcript.slice(0, 1000),
        called_at: callLog.call_start_time || new Date().toISOString(),
      });
      collectionAttemptId = attempt.id;

      // Mirror back onto the LoanAccount
      if (loanAccount) {
        const update = {
          last_outcome: outcome,
          last_called_at: callLog.call_end_time || new Date().toISOString(),
          total_attempts: (loanAccount.total_attempts || 0) + 1,
        };
        if (outcome === 'ptp' && ptpDate) {
          update.ptp_date = ptpDate;
          update.ptp_amount = ptpAmount;
          update.status = 'ptp';
        } else if (outcome === 'paid_now' || outcome === 'already_paid') {
          update.status = 'active';
        } else if (outcome === 'dispute') {
          update.status = 'under_collection';
        }
        await base44.entities.LoanAccount.update(loanAccount.id, update);
      }

      // Auto-add to DNC on do_not_call
      if (outcome === 'do_not_call' && callLog.callee_number) {
        try {
          await base44.functions.invoke('bfsiDncAdd', {
            client_id: callLog.client_id,
            phone: callLog.callee_number,
            source: 'borrower_request',
            reason: `Auto-added from call ${callLogId} — borrower said do-not-call.`,
            loan_account_id: loanAccountId,
          });
        } catch (e) {
          console.error('[bfsiPostCallProcessor] DNC add failed:', e.message);
        }
      }

      // Auto-send payment link on PTP / paid_now
      if (['ptp', 'paid_now'].includes(outcome) && loanAccountId) {
        try {
          const plRes = await base44.functions.invoke('bfsiSendPaymentLink', {
            client_id: callLog.client_id,
            loan_account_id: loanAccountId,
            amount: extractPtpAmount(transcript) || extractPtpAmount(summary) || loanAccount?.emi_amount,
            ptp_date: extractPtpDate(transcript) || extractPtpDate(summary),
            call_log_id: callLogId,
          });
          if (plRes?.data?.sent) {
            // Mirror onto CollectionAttempt
            if (collectionAttemptId) {
              await base44.entities.CollectionAttempt.update(collectionAttemptId, {
                payment_link_sent: true,
                payment_link_channel: 'whatsapp',
                payment_link_url: plRes.data.payment_url,
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error('[bfsiPostCallProcessor] Payment link send failed:', e.message);
        }
      }
    }

    // ─── TVR / VERIFICATION ───
    if (caseType === 'verification' && campaignLead?.lead_id) {
      const vcase = await base44.entities.VerificationCase.get(campaignLead.lead_id).catch(() => null);
      if (vcase) {
        // Heuristic: outcome mapping
        const outcomeMap = {
          ptp: 'partial', paid_now: 'verified', already_paid: 'verified',
          dispute: 'rejected', request_callback: 'callback',
          no_answer: 'not_contactable', deceased: 'rejected',
        };
        verificationStatus = outcomeMap[outcome] || 'callback';
        await base44.entities.VerificationCase.update(vcase.id, {
          verification_status: verificationStatus,
          call_log_id: callLogId,
          ai_summary: summary.slice(0, 1000),
          completed_at: new Date().toISOString(),
        });
      }
    }

    // ─── RCU ───
    if (caseType === 'rcu' && campaignLead?.lead_id) {
      const refCheck = await base44.entities.ReferenceCheck.get(campaignLead.lead_id).catch(() => null);
      if (refCheck) {
        const rcuMap = {
          paid_now: 'verified', already_paid: 'verified', ptp: 'verified',
          dispute: 'mismatch', do_not_call: 'refused', request_human: 'refused',
          no_answer: 'unreachable',
        };
        await base44.entities.ReferenceCheck.update(refCheck.id, {
          status: rcuMap[outcome] || 'unreachable',
          call_log_id: callLogId,
          ai_summary: summary.slice(0, 1000),
          completed_at: new Date().toISOString(),
        });
      }
    }

    // ─── COMPLIANCE LOG (always, for every BFSI call) ───
    try {
      await base44.functions.invoke('logBfsiCompliance', {
        call_log_id: callLogId,
        case_type: caseType,
        transcript_sample: transcript.slice(0, 4000),
      });
    } catch (e) {
      console.error('[bfsiPostCallProcessor] logBfsiCompliance failed:', e.message);
    }

    // Mark CallLog as processed (idempotency flag)
    await base44.entities.CallLog.update(callLogId, {
      transferred_to: 'bfsi_processed',
    }).catch(() => {});

    console.log(`[bfsiPostCallProcessor] case=${caseType} outcome=${outcome} attempt=${collectionAttemptId} vstatus=${verificationStatus}`);
    return c.json({ data: {
      success: true,
      case_type: caseType,
      outcome,
      collection_attempt_id: collectionAttemptId,
      verification_status: verificationStatus,
    } });
  } catch (error) {
    console.error('[bfsiPostCallProcessor] error:', error);
    return c.json({ data: { error: error.message } }, 500);
  }

};