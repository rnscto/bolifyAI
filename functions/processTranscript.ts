import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { call_log_id, recording_url } = await req.json();

    if (!call_log_id || !recording_url) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const callLog = await base44.asServiceRole.entities.CallLog.get(call_log_id);
    if (!callLog) {
      return Response.json({ error: 'Call log not found' }, { status: 404 });
    }

    // Download audio file
    const audioResponse = await fetch(recording_url);
    const audioBlob = await audioResponse.blob();

    // Convert to Azure Speech API format
    const formData = new FormData();
    formData.append('audio', audioBlob);

    // Azure Speech to Text
    const sttEndpoint = `https://${Deno.env.get('AZURE_SPEECH_REGION')}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;
    
    const sttResponse = await fetch(sttEndpoint, {
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
    const analysisResponse = await fetch(
      `${Deno.env.get('AZURE_OPENAI_ENDPOINT')}/openai/deployments/${Deno.env.get('AZURE_OPENAI_DEPLOYMENT')}/chat/completions?api-version=2024-08-01-preview`,
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

    // Extract lead status from summary (simple parsing)
    let leadStatus = 'contacted';
    if (summary.toLowerCase().includes('interested')) leadStatus = 'interested';
    if (summary.toLowerCase().includes('not interested')) leadStatus = 'not_interested';
    if (summary.toLowerCase().includes('callback')) leadStatus = 'callback';
    if (summary.toLowerCase().includes('converted')) leadStatus = 'converted';

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