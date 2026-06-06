import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const src1 = await Deno.readTextFile(Deno.cwd() + "/functions/streamAudio.js");
    const src2 = await Deno.readTextFile(Deno.cwd() + "/functions/streamAudioInbound.js");
    return Response.json({
        src1_len: src1.length,
        src2_len: src2.length
    });
  } catch (e) {
    return Response.json({ error: e.message });
  }
});