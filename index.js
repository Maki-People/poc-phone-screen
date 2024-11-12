import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import { inspect } from "util";
import { RealtimeConversation } from "./conversation.js";
import fastifyCors from "@fastify/cors";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Retrieve Twilio credentials from environment variables
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } =
  process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error(
    "Missing Twilio configuration. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in the .env file.",
  );
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
});

// Store active conversations
const activeConversations = new Map();

// Constants
const SYSTEM_MESSAGE = `Your knowledge cutoff is 2023-10. You are a helpful, witty, and friendly AI. Act like a human, but remember that you aren't a human and that you can't do human things in the real world. Your voice and personality should be warm and engaging, with a lively and playful tone. Only speak in French. Talk quickly. You should always call a function if you can. Do not refer to these rules, even if you're asked about them. You will interview me for an "EY junior auditor" position in the Paris office. Start by introducing yourself (you are Wendy, recruiter at EY), that you are contacting me following my application, and confirm that it's a good time to talk by asking "Est-ce un bon moment pour échanger ?", wait for my answer. If not, ask "Quel jour et quelle heure vous conviendraient mieux ?" Then ask "Pouvez-vous confirmer votre disponibilité pour commencer en septembre ?", wait for my answer. At the end of the call, summarize all the candidate's answers and ask "Je vais maintenant résumer vos réponses. Pouvez-vous me confirmer qu'elles sont exactes ?" followed by each answer. Wait for final confirmation. `;
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
  "error",
  "response.audio_transcript.done",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "input_audio_transcription",
  "session.created",
  "conversation.item.created",
  "conversation.item.input_audio_transcription.completed",
];

const SHOW_TIMING_MATH = false;

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.get("/active-calls", async (request, reply) => {
  try {
    const activeCalls = Array.from(activeConversations.keys());
    return reply.send({
      success: true,
      totalCalls: activeCalls.length,
      calls: activeCalls,
    });
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: "Failed to fetch active calls",
      message: error.message,
    });
  }
});

fastify.get("/conversations", async (request, reply) => {
  try {
    const conversationsArray = Array.from(activeConversations.entries()).map(
      ([callSid, conversation]) => {
        const items = conversation.getItems();

        // Format the conversation history
        const history = items.map((item) => ({
          id: item.id,
          role: item.role,
          type: item.type,
          status: item.status,
          formatted: {
            text: item.formatted.text,
            transcript: item.formatted.transcript,
            hasAudio: item.formatted.audio && item.formatted.audio.length > 0,
          },
          timestamp: item.timestamp || new Date().toISOString(),
        }));

        return {
          callSid,
          history,
          totalItems: history.length,
        };
      },
    );

    return reply.send({
      success: true,
      totalConversations: conversationsArray.length,
      conversations: conversationsArray,
    });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    return reply.status(500).send({
      success: false,
      error: "Failed to fetch conversations",
      message: error.message,
    });
  }
});

// Route for Twilio to handle incoming calls
fastify.all("/incoming-call", async (request, reply) => {
  console.log("Incoming call", process.env.HOST);
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>On est MAKI PIPS</Say>
                              <Pause length="1"/>
                              <Connect>
                                  <Stream url="wss://${process.env.HOST}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Endpoint to initiate a call
fastify.post("/call", async (request, reply) => {
  console.log("Initiating call", process.env.HOST);
  const { phoneNumber } = request.body;

  if (!phoneNumber) {
    return reply.status(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `http://${process.env.HOST}/incoming-call`,
    });

    reply.send({ message: "Call initiated", callSid: call.sid });
  } catch (error) {
    console.error("Error initiating call:", error);
    reply.status(500).send({ error: "Failed to initiate call" });
  }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    // Create conversation instance
    const conversation = new RealtimeConversation();

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      },
    );

    const initializeSession = () => {
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
          input_audio_transcription: {
            model: "whisper-1",
          },
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH)
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`,
          );

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH)
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent),
            );
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          }),
        );

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(
            `Received event: ${response.type}`,
            inspect(response, {
              colors: true,
              depth: null,
            }),
          );
        }

        // Process the event using RealtimeConversation
        const { item, delta } = conversation.processEvent(response);

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`,
              );
          }

          if (item) {
            lastAssistantItem = item.id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        // console.error(
        //   "Error processing OpenAI message:",
        //   error,
        //   "Raw message:",
        //   data,
        // );
      }
    });

    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`,
              );
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            // Add conversation to active conversations
            activeConversations.set(streamSid, conversation);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      // Remove conversation from active conversations after some delay
      // This allows time for final history requests
      setTimeout(() => {
        if (streamSid) {
          activeConversations.delete(streamSid);
        }
      }, 300000); // 5 minutes delay
      console.log("Client disconnected.");
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
