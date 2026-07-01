import { base44ORM as base44 } from "../db/orm.ts";
import { client } from "../db/index.ts";

import { EmailClient } from 'npm:@azure/communication-email@1.0.0';

let _emailClient: any;
function getEmailClient() {
  if (!_emailClient) {
    const ep = Deno.env.get('AZURE_COMM_ENDPOINT');
    const key = Deno.env.get('AZURE_COMM_KEY');
    if (!ep || !key) throw new Error("Missing AZURE_COMM_ENDPOINT or AZURE_COMM_KEY");
    _emailClient = new EmailClient(`endpoint=${ep};accesskey=${key}`);
  }
  return _emailClient;
}

const TEMPLATES = {
  free_trial: {
    subject: '🎉 Start Your 7-Day Free Trial — VaaniAI',
    body: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png" alt="VaaniAI" style="height: 60px; margin-bottom: 20px;" />
  <h2 style="color: #1a365d;">Welcome to VaaniAI! 🚀</h2>
  <p>Hi {{name}},</p>
  <p>Great speaking with you! Here's your <strong>7-day free trial</strong> link — no credit card required:</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{trial_link}}" style="background: linear-gradient(135deg, #2563eb, #1a365d); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">Start Free Trial →</a>
  </div>
  <p><strong>What you get:</strong></p>
  <ul>
    <li>✅ AI Voice Agent with unlimited calls</li>
    <li>✅ Real-time transcription & summaries</li>
    <li>✅ Campaign management</li>
    <li>✅ Knowledge base training</li>
  </ul>
  <p>Questions? Just reply to this email or call us.</p>
  <p style="color: #666; font-size: 12px; margin-top: 30px;">— Team VaaniAI | Made in India 🇮🇳</p>
</div>`
  },
  pricing: {
    subject: '💰 VaaniAI Pricing Details — As Requested',
    body: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png" alt="VaaniAI" style="height: 60px; margin-bottom: 20px;" />
  <h2 style="color: #1a365d;">VaaniAI Pricing 💰</h2>
  <p>Hi {{name}},</p>
  <p>Here are the pricing details you asked about:</p>
  <div style="background: #f0f5ff; border-radius: 12px; padding: 20px; margin: 20px 0;">
    <h3 style="color: #1a365d; margin-top: 0;">AI Voice Agent</h3>
    <p style="font-size: 28px; font-weight: bold; color: #2563eb; margin: 5px 0;">₹6,500<span style="font-size: 14px; color: #666;">/month per channel</span></p>
    <p style="color: #666;">Billed quarterly at ₹19,500</p>
    <ul style="list-style: none; padding: 0;">
      <li>✅ Unlimited calls & minutes</li>
      <li>✅ AI voice agent (English + Hindi)</li>
      <li>✅ Real-time transcription</li>
      <li>✅ Campaign management</li>
      <li>✅ 7-day free trial included</li>
    </ul>
    <h3 style="color: #1a365d;">Sales CRM Add-on</h3>
    <p style="font-size: 22px; font-weight: bold; color: #2563eb; margin: 5px 0;">₹1,999<span style="font-size: 14px; color: #666;">/month</span></p>
  </div>
  <div style="text-align: center; margin: 25px 0;">
    <a href="{{trial_link}}" style="background: linear-gradient(135deg, #2563eb, #1a365d); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Start Free Trial →</a>
  </div>
  <p style="color: #666; font-size: 12px; margin-top: 30px;">— Team VaaniAI | Made in India 🇮🇳</p>
</div>`
  },
  demo: {
    subject: '🎬 Your VaaniAI Demo — Book a Slot',
    body: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png" alt="VaaniAI" style="height: 60px; margin-bottom: 20px;" />
  <h2 style="color: #1a365d;">Let's Show You VaaniAI in Action! 🎬</h2>
  <p>Hi {{name}},</p>
  <p>Thanks for your interest! Here are some quick ways to explore VaaniAI:</p>
  <div style="text-align: center; margin: 25px 0;">
    <a href="{{trial_link}}" style="background: linear-gradient(135deg, #2563eb, #1a365d); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 8px;">Start Free Trial →</a>
    <br/>
    <a href="{{demo_link}}" style="background: linear-gradient(135deg, #e67e22, #f39c12); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 8px;">Book Live Demo →</a>
  </div>
  <p>Our team will reach out to schedule a personalized walkthrough.</p>
  <p style="color: #666; font-size: 12px; margin-top: 30px;">— Team VaaniAI | Made in India 🇮🇳</p>
</div>`
  },
  offer: {
    subject: '🔥 Special Offer for You — VaaniAI',
    body: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/698823c19043e168a5daaa86/9b1876319_WhatsApp_Image_2026-02-11_at_44923_PM-removebg-preview.png" alt="VaaniAI" style="height: 60px; margin-bottom: 20px;" />
  <h2 style="color: #1a365d;">🔥 Exclusive Offer Just for You!</h2>
  <p>Hi {{name}},</p>
  <p>As discussed, here's a special offer:</p>
  <div style="background: linear-gradient(135deg, #fff7ed, #ffedd5); border: 2px solid #f97316; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
    <p style="font-size: 14px; color: #c2410c; font-weight: bold; margin: 0;">LIMITED TIME OFFER</p>
    <p style="font-size: 32px; font-weight: bold; color: #ea580c; margin: 10px 0;">20% OFF</p>
    <p style="color: #666;">First quarter subscription</p>
    <p style="background: #1a365d; color: white; display: inline-block; padding: 8px 20px; border-radius: 6px; font-family: monospace; font-size: 18px; letter-spacing: 2px; margin-top: 10px;">VAANI20</p>
  </div>
  <div style="text-align: center; margin: 25px 0;">
    <a href="{{trial_link}}" style="background: linear-gradient(135deg, #ea580c, #f97316); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">Claim Your Offer →</a>
  </div>
  <p style="font-size: 12px; color: #999;">*Offer valid for 48 hours from this email.</p>
  <p style="color: #666; font-size: 12px; margin-top: 30px;">— Team VaaniAI | Made in India 🇮🇳</p>
</div>`
  }
};

export default async function sendVoiceAgentEmail(c: any) {
  const req = c.req.raw || c.req;
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Base44-App-Id'
      }
    });
  }

  try {
    const body = await c.req.json();
    const { email, name, template_type } = body;

    if (!email) {
      return c.json({ data: { error: 'Email is required' } }, 400);
    }

    const template = TEMPLATES[template_type] || TEMPLATES.free_trial;
    const siteUrl = 'https://vaaniai.io';
    const trialLink = siteUrl;
    const demoLink = siteUrl;

    const finalBody = template.body
      .replace(/\{\{name\}\}/g, name || 'there')
      .replace(/\{\{trial_link\}\}/g, trialLink)
      .replace(/\{\{demo_link\}\}/g, demoLink);

    const message = {
      senderAddress: 'DoNotReply@vaaniai.io',
      displayName: 'VaaniAI',
      content: { subject: template.subject, html: finalBody },
      recipients: { to: [{ address: email }] }
    };
    const poller = await getEmailClient().beginSend(message);
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') {
      throw new Error(`ACS Email error: ${result.error?.message || result.status}`);
    }

    console.log(`✅ Email sent: ${template_type} → ${email}`);
    return c.json({ data: { success: true, template_type } });
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return c.json({ data: { error: err.message } }, 500);
  }

};