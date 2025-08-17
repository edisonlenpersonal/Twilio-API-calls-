import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio'; // Ensure this is imported correctly

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key and Twilio credentials from environment variables
const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TO_PHONE_NUMBER } = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !TO_PHONE_NUMBER) {
    console.error('Missing required environment variables. Please set them in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';
const VOICE = 'alloy';
const PORT = 5050; // Allow dynamic port assignment

// Twilio Client Setup
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route to Initiate an Outbound Call
fastify.get('/make-call', async (request, reply) => {
    try {
        const call = await twilioClient.calls.create({
            to: TO_PHONE_NUMBER,            // The phone number to call
            from: TWILIO_PHONE_NUMBER,      // Your Twilio phone number
            url: `https://${request.headers.host}/incoming-call`, // The Twilio webhook URL
        });
        reply.send({ message: `Call initiated successfully! Call SID: ${call.sid}` });
    } catch (error) {
        console.error('Error initiating call:', error);
        reply.status(500).send({ error: 'Failed to initiate call' });
    }
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream (same as your original code)
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }  // Directly sending delta, no base64 encoding needed // semd the audio file
                    };
                    connection.send(JSON.stringify(audioDelta));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // here is where the audio chunk can be placed
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Helper function to handle the "mark" (finish timestamp)
function sendMark(connection, streamSid) {
    const markPayload = {
        event: 'mark',
        streamSid: streamSid
    };

    connection.send(JSON.stringify(markPayload));
}

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});


