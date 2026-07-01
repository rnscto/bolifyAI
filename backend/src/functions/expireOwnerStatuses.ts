import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";
// Scheduled function: Auto-deactivate expired OwnerStatus records
// Runs every 5 minutes to ensure statuses with end_time are reset when they expire



export default async function expireOwnerStatuses(c: any) {
  const req = c.req.raw || c.req;
  try {
    /* const base44 = ... */;

    const allActive = await base44.asServiceRole.entities.OwnerStatus.filter({ is_active: true });
    const now = new Date();
    let deactivated = 0;

    for (const status of allActive) {
      if (!status.end_time) continue;

      let endDate = null;
      // Try ISO datetime first
      const isoTest = new Date(status.end_time);
      if (!isNaN(isoTest.getTime()) && status.end_time.includes('-')) {
        endDate = isoTest;
      } else {
        // Parse time-only like "3:00 PM" or "15:00" — assume today IST
        const todayIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const timeParts = status.end_time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        if (timeParts) {
          let h = parseInt(timeParts[1]), m = parseInt(timeParts[2]);
          if (timeParts[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
          if (timeParts[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
          todayIST.setHours(h, m, 0, 0);
          endDate = todayIST;
        }
      }

      if (endDate && now > endDate) {
        await base44.asServiceRole.entities.OwnerStatus.update(status.id, { is_active: false });
        deactivated++;
        console.log(`[expireOwnerStatuses] Deactivated "${status.title}" for client ${status.client_id} (end_time=${status.end_time})`);

        // Send Telegram notification that status has been reset
        const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        if (tgToken && status.client_id) {
          try {
            const client = await base44.asServiceRole.entities.Client.get(status.client_id);
            if (client?.telegram_connected && client?.telegram_chat_id && client?.owner_notification_channel === 'telegram') {
              const msg = `✅ <b>Status Reset</b>\n\n${status.icon} "<b>${status.title}</b>" has expired and been automatically deactivated.\n\n📱 You're now back to default call screening mode.`;
              fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: client.telegram_chat_id, text: msg, parse_mode: 'HTML' })
              }).catch(() => {});
            }
          } catch (_) {}
        }
      }
    }

    return c.json({ data: { success: true, deactivated, checked: allActive.length } });
  } catch (error) {
    console.error('[expireOwnerStatuses] Error:', error.message);
    return c.json({ data: { error: error.message } }, 500);
  }

};