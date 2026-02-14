import { createClientFromRequest } from 'npm:@base44/sdk@0.8.18';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const { call_log_id, recording_url } = await req.json();

    if (!call_log_id || !recording_url) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate recording_url is a proper URL
    try {
      new URL(recording_url);
    } catch (_) {
      return Response.json({ error: 'Invalid recording URL' }, { status: 400 });
    }

    const callLog = await base44.asServiceRole.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return Response.json({ error: 'Call log not found' }, { status: 404 });
    }

    // Download audio file
    const audioResponse = await fetch(recording_url);
    const audioBlob = await audioResponse.blob();

    // Azure Speech to Text
    const sttResponse = await fetch(Deno.env.get('AZURE_SPEECH_ENDPOINT'), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'audio/wav'
      },
      body: audioBlob
    });

    if (!sttResponse.ok) {
      console.error('STT failed:', await sttResponse.text());
      return Response.json({ error: 'Speech to text failed' }, { status: 500 });
    }

    const sttData = await sttResponse.json();
    const transcript = sttData.DisplayText || sttData.NBest?.[0]?.Display || '';

    // Use Azure OpenAI to analyze conversation
    const baseUrl = Deno.env.get('AZURE_OPENAI_ENDPOINT')?.replace(/\/+$/, '');
    const analysisResponse = await fetch(
      `${baseUrl}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
      {
        method: 'POST',
        headers: {
          'api-key': Deno.env.get('AZURE_OPENAI_KEY'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: 'You are an AI assistant that analyzes sales call transcripts. Provide a summary, identify lead interest level, and suggest next actions.'
            },
            {
              role: 'user',
              content: `Analyze this call transcript and provide:\n1. Brief summary\n2. Lead status (interested/not_interested/callback/converted)\n3. Key points discussed\n\nTranscript:\n${transcript}`
            }
          ],
          max_tokens: 500,
          temperature: 0.3
        })
      }
    );

    if (!analysisResponse.ok) {
      console.error('OpenAI analysis failed:', await analysisResponse.text());
    }

    const analysisData = await analysisResponse.json();
    const summary = analysisData.choices?.[0]?.message?.content || 'Analysis not available';

    // Extract lead status from summary
    let leadStatus = 'contacted';
    if (summary.toLowerCase().includes('not interested')) leadStatus = 'not_interested';
    else if (summary.toLowerCase().includes('interested')) leadStatus = 'interested';
    else if (summary.toLowerCase().includes('callback')) leadStatus = 'callback';
    else if (summary.toLowerCase().includes('converted')) leadStatus = 'converted';

    // Update call log with transcript and summary
    await base44.asServiceRole.entities.CallLog.update(call_log_id, {
      transcript,
      conversation_summary: summary,
      lead_status_updated: leadStatus
    });

    // Update lead status
    if (callLog.lead_id) {
      await base44.asServiceRole.entities.Lead.update(callLog.lead_id, {
        status: leadStatus,
        last_call_date: new Date().toISOString(),
        notes: `Last call: ${summary.substring(0, 200)}...`
      });
    }

    // Trigger post-call follow-up emails & RCS
    try {
      await base44.asServiceRole.functions.invoke('postCallFollowup', {
        call_log_id: call_log_id
      });
      console.log('[processTranscript] Post-call follow-up triggered');
    } catch (followupErr) {
      console.error('[processTranscript] Post-call follow-up error:', followupErr.message);
    }

    return Response.json({ 
      success: true,
      transcript,
      summary,
      lead_status: leadStatus
    });

  } catch (error) {
    console.error('Error processing transcript:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});