import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// WebSocket handler for real-time audio streaming with Smartflo
Deno.serve(async (req) => {
  try {
    // Upgrade HTTP request to WebSocket
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket connection", { status: 426 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const base44 = createClientFromRequest(req);

    // Extract call_sid from URL
    const url = new URL(req.url);
    const callSid = url.pathname.split('/').pop();

    let callLog = null;
    let agent = null;

    socket.onopen = async () => {
      console.log('WebSocket opened for call:', callSid);
      
      try {
        // Get call details
        const callLogs = await base44.asServiceRole.entities.CallLog.filter({ call_sid: callSid });
        if (callLogs.length > 0) {
          callLog = callLogs[0];
          agent = await base44.asServiceRole.entities.Agent.get(callLog.agent_id);
        }
      } catch (error) {
        console.error('Error loading call data:', error);
      }
    };

    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle different message types from Smartflo
        if (data.event === 'connected') {
          console.log('Stream connected:', callSid);
          
          // Send initial greeting using Azure TTS
          if (agent && agent.system_prompt) {
            const greeting = await generateSpeech(agent.system_prompt.substring(0, 200));
            socket.send(JSON.stringify({
              event: 'media',
              media: { payload: greeting }
            }));
          }
        }

        if (data.event === 'media' && data.media) {
          // Received audio from caller - process with Azure STT
          const audioPayload = data.media.payload;
          
          // Convert audio to text
          const text = await speechToText(audioPayload);
          
          if (text) {
            console.log('Transcribed:', text);
            
            // Get AI response from Azure OpenAI
            const aiResponse = await getAIResponse(text, agent, callLog);
            
            // Convert response to speech
            const speechAudio = await generateSpeech(aiResponse);
            
            // Send speech back to caller
            socket.send(JSON.stringify({
              event: 'media',
              media: { payload: speechAudio }
            }));
          }
        }

        if (data.event === 'stop') {
          console.log('Stream stopped:', callSid);
          socket.close();
        }

      } catch (error) {
        console.error('Error processing message:', error);
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    socket.onclose = () => {
      console.log('WebSocket closed for call:', callSid);
    };

    return response;

  } catch (error) {
    console.error('Error setting up WebSocket:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Azure Speech to Text
async function speechToText(audioBase64) {
  try {
    const audioBuffer = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
    
    const endpoint = `https://${Deno.env.get('AZURE_SPEECH_REGION')}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'audio/wav'
      },
      body: audioBuffer
    });

    if (response.ok) {
      const data = await response.json();
      return data.DisplayText || '';
    }
    return '';
  } catch (error) {
    console.error('STT error:', error);
    return '';
  }
}

// Azure Text to Speech
async function generateSpeech(text) {
  try {
    const endpoint = `https://${Deno.env.get('AZURE_SPEECH_REGION')}.tts.speech.microsoft.com/cognitiveservices/v1`;
    
    const ssml = `
      <speak version='1.0' xml:lang='en-US'>
        <voice xml:lang='en-US' name='en-US-JennyNeural'>
          ${text}
        </voice>
      </speak>
    `;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': Deno.env.get('AZURE_SPEECH_KEY'),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3'
      },
      body: ssml
    });

    if (response.ok) {
      const audioBuffer = await response.arrayBuffer();
      const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));
      return base64Audio;
    }
    return '';
  } catch (error) {
    console.error('TTS error:', error);
    return '';
  }
}

// Get AI response from Azure OpenAI
async function getAIResponse(userText, agent, callLog) {
  try {
    const response = await fetch(
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
              content: agent?.system_prompt || 'You are a helpful sales assistant.'
            },
            {
              role: 'user',
              content: userText
            }
          ],
          max_tokens: 150,
          temperature: 0.7
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || 'I understand.';
    }
    return 'I understand.';
  } catch (error) {
    console.error('OpenAI error:', error);
    return 'I understand.';
  }
}