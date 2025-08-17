///////////////////////////////////////////
// Imports and Environment Setup
///////////////////////////////////////////
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
dotenv.config();

///////////////////////////////////////////
// Twilio and OpenAI Credentials
///////////////////////////////////////////
const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_TO_NUMBER,
  TWILIO_FROM_NUMBER,
  PORT
} = process.env;

// Basic validation
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in .env');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) {
  console.error('Missing Twilio credentials or phone numbers in .env');
  process.exit(1);
}

// Create Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

///////////////////////////////////////////
// Fastify App Setup
///////////////////////////////////////////
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

///////////////////////////////////////////
// Constants for OpenAI real-time
///////////////////////////////////////////
const SYSTEM_MESSAGE = "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = 'alloy';

///////////////////////////////////////////
// 1. Route to Trigger an Outbound Call
///////////////////////////////////////////
fastify.post('/outbound-call', async (request, reply) => {
  try {
    // You can get `toNumber` from request.body or use environment variable
    const toNumber = TWILIO_TO_NUMBER;
    const fromNumber = TWILIO_FROM_NUMBER;

    // The URL that Twilio will request for TwiML
    const twimlUrl = `https://${request.headers.host}/twilio-voice-twiml`; 

    // Initiate the outbound call
    const call = await client.calls.create({
      url: twimlUrl,    // This is where Twilio fetches the instructions (TwiML)
      to: toNumber,
      from: fromNumber,
      // Optionally add statusCallback if you want to handle call events
      // statusCallback: 'https://yourdomain.com/call-status',
      // statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log('Call initiated. Call SID:', call.sid);
    reply.send({ success: true, message: 'Call initiated', callSid: call.sid });
  } catch (error) {
    console.error('Error initiating call:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
});

///////////////////////////////////////////
// 2. TwiML Endpoint for the Phone Call
///////////////////////////////////////////
fastify.all('/twilio-voice-twiml', async (request, reply) => {
  // This TwiML is what Twilio runs once the call is answered
  // We instruct Twilio to say something, then connect the call to a WebSocket stream.
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect your call to the A.I. voice assistant, powered by Twilio and the OpenAI Realtime API.</Say>
  <Pause length="1" />
  <Say>O.K., you can start talking!</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

///////////////////////////////////////////
// 3. WebSocket Route for Media Streaming
///////////////////////////////////////////
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("Client connected to /media-stream");

    // Connect to OpenAI Realtime API
    const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-40-realtime-preview-2024-10-01", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let streamSid = null;

    // Helper to send session update with audio settings to OpenAI
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };
      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // When OpenAI connection is open, send the session update
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      // Delay sending session.update slightly
      setTimeout(sendSessionUpdate, 1000);
    });

    // Handle OpenAI messages
    openAiWs.on("message", (rawData) => {
      try {
        const response = JSON.parse(rawData);
        // If session updated
        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }
        // If we have an audio delta
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              // The base64 from OpenAI is G.711 u-law
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          // Send audio data back to Twilio media stream
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error("Error processing OpenAI message:", error, "Raw message:", rawData);
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });

    // Handle incoming messages from Twilio (speech audio)
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream started:", streamSid);
            break;

          case "media":
            // Forward the G.711 audio to OpenAI if connected
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload, // base64-encoded ulaw
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;

          default:
            console.log("Received non-media event:", data.event);
        }
      } catch (error) {
        console.error("Error parsing Twilio WS message:", error, "Message:", message);
      }
    });

    // Clean up on close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      console.log("Client disconnected from /media-stream.");
    });
  });
});

///////////////////////////////////////////
// 4. Start the Server
///////////////////////////////////////////
fastify.listen({ port: PORT || 5050, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT || 5050}`);
});
