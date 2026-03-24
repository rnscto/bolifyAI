import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

// Quick test to verify Smartflo login API works with stored credentials
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const email = Deno.env.get('SMARTFLO_EMAIL');
    const password = Deno.env.get('SMARTFLO_PASSWORD');

    if (!email || !password) {
      return Response.json({ error: 'SMARTFLO_EMAIL or SMARTFLO_PASSWORD not set' }, { status: 500 });
    }

    console.log(`Testing Smartflo login with email: ${email}`);

    const loginResp = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const loginData = await loginResp.json();
    console.log('Smartflo login response status:', loginResp.status);
    console.log('Smartflo login response:', JSON.stringify(loginData).substring(0, 500));

    if (!loginResp.ok || !loginData.token) {
      return Response.json({
        success: false,
        status: loginResp.status,
        message: loginData.message || 'No token returned',
        response: loginData
      });
    }

    return Response.json({
      success: true,
      message: 'Smartflo login successful!',
      token_preview: loginData.token.substring(0, 30) + '...',
      token_length: loginData.token.length
    });

  } catch (error) {
    console.error('Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});