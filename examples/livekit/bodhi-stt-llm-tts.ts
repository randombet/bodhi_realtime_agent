// SPDX-License-Identifier: MIT
/**
 * Bodhi — Senior-Friendly Voice Assistant (LiveKit, cascaded STT + LLM + TTS)
 *
 * The LiveKit-agents-js counterpart of examples/openai-realtime-tools.ts. Same
 * warm, senior-friendly "Bodhi" persona and the same capabilities — function
 * tools, background image/video generation, multi-agent transfer, graceful
 * end — but built on a CASCADED pipeline (Deepgram STT → OpenAI LLM →
 * Cartesia TTS) over LiveKit's WebRTC transport, instead of one
 * speech-to-speech model over a raw WebSocket.
 *
 * Design: dev_docs/framework/design-livekit-stt-llm-tts-example.md
 *
 * Providers (PROVIDER env, default "plugins"):
 *   - "plugins":   Deepgram STT + OpenAI LLM + Cartesia TTS (your own API keys)
 *   - "inference": LiveKit Cloud inference gateway for all three (LIVEKIT_* only)
 *
 * Run (from examples/livekit/ — this is a self-contained package):
 *   pnpm install
 *   pnpm download-files       # one-time: fetch turn-detector + silero ONNX models
 *   pnpm dev                  # inherits exported env;
 *                             # or: tsx --env-file=.env bodhi-stt-llm-tts.ts dev
 *
 * Connect a client: `pnpm client` then open http://127.0.0.1:8080 (see README / client.html).
 *
 * Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (always);
 *      DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY (PROVIDER=plugins);
 *      GEMINI_API_KEY (image/video). Optional: CARTESIA_VOICE_ID.
 */
// Load examples/livekit/.env (from cwd) before anything reads process.env.
// dotenv does NOT override already-exported vars, so shell exports still win.
import 'dotenv/config';
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import type { ByteStreamWriter } from '@livekit/rtc-node';
import type { Room } from '@livekit/rtc-node';
import { GoogleGenAI } from '@google/genai';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CalculatorError, evaluate } from './calculator.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Must match RoomAgentDispatch.agentName in mint-token.ts (explicit dispatch).
const AGENT_NAME = 'bodhi';
const PROVIDER = process.env.PROVIDER === 'inference' ? 'inference' : 'plugins';
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID ?? '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';

// Topics — the client (examples/livekit/client.html) subscribes to these.
const TOPIC_GUI = 'bodhi.gui'; // asset lifecycle (publishData) + asset bytes (streamBytes)
const TOPIC_SESSION = 'bodhi.session'; // session-control events (e.g. session_end)

// Video config (enforced in code, not via the prompt).
// IMPORTANT: Veo 3.1 only accepts durationSeconds of 4, 6, or 8 — NOT arbitrary values
// in [4,8] (the "between 4 and 8" API error is misleading; 5 is rejected). 720p is the
// default and works at any of those; 1080p/4k would force durationSeconds=8.
const VIDEO_DURATION_SECONDS = 4;
const VIDEO_RESOLUTION = '720p';
const VIDEO_ASPECT_RATIO = '16:9';

type UserData = {
  hasGreeted: boolean;
};

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

const GREETING_INSTRUCTIONS =
  'A user just connected. Greet them warmly. Introduce yourself as Bodhi, their voice ' +
  'assistant. Briefly say you can help with math, telling the time, and creating pictures ' +
  'or short videos from a description. Then ask how you can help today. Keep it friendly ' +
  'and short.';

const MAIN_INSTRUCTIONS = `You are a warm, patient voice assistant for older adults. Your name is Bodhi. Speak as a trusted companion — calm, clear, and never rushed.

VOICE & PACING:
- Deliver ONE idea per turn. Never chain two topics together.
- Keep every response under 3 sentences unless the user asks for more detail.
- Speak at a measured pace. If the user seems confused, slow down and rephrase.

LANGUAGE:
- Short, simple sentences. Everyday words ("start" not "initiate", "use" not "utilize").
- Positive phrasing. Offer binary choices, not open-ended questions.
- Never say "As an AI". Never use filler like "Great question!".

TOOLS:
- calculate: simple math for the user.
- get_current_time: the current time/date.
- generate_image: ALWAYS call this when the user wants any picture, image, card, or illustration. Do not describe an image verbally — call the tool so they can see it.
- generate_video: call this when the user wants a video or animation. Warn them it takes a minute or two. Videos are short — only a few seconds.
- transfer to math helper: for harder math, say "Let me connect you with our math specialist." then call talk_to_math_expert.
- end_session: when the user says goodbye or is done, say a warm goodbye and call it.`;

const MATH_INSTRUCTIONS = `You are a patient math helper named Bodhi, explaining math in plain language for older adults.

- One step at a time. Pause after each step. Keep sentences short.
- Use the calculate tool for the actual arithmetic — never ask the user to compute.
- Say numbers clearly.
- When the user has no more math questions, say "I will take you back to your main assistant now." then call back_to_main.`;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

class MainAgent extends voice.Agent<UserData> {
  async onEnter(): Promise<void> {
    if (!this.session.userData.hasGreeted) {
      this.session.userData.hasGreeted = true;
      this.session.generateReply({ instructions: GREETING_INSTRUCTIONS });
    } else {
      this.session.generateReply({
        instructions: 'Welcome the user back in one short sentence and ask how you can help.',
      });
    }
  }
}

class MathExpertAgent extends voice.Agent<UserData> {
  async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions: 'Greet briefly as the math helper, then ask what math problem they need help with.',
    });
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const logger = log();
    const room: Room = ctx.room;
    const ts = () => new Date().toISOString().slice(11, 23);

    // -- client publishing helpers (room is NOT available on the tool ctx) ---

    /** Best-effort JSON control/metadata message on a topic. */
    const publishJson = async (topic: string, data: Record<string, unknown>): Promise<void> => {
      try {
        await room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(data)), {
          topic,
          reliable: true,
        });
      } catch (err) {
        logger.warn({ err, topic }, 'publishData failed (room may be closed)');
      }
    };

    // -- background-asset generation: detached, session-registered tasks -----

    type AssetTask = { id: string; controller: AbortController; promise: Promise<void> };
    const tasks = new Set<AssetTask>();
    let assetCounter = 0;
    const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

    const streamBytesToClient = async (
      assetId: string,
      bytes: Uint8Array,
      mimeType: string,
    ): Promise<void> => {
      let writer: ByteStreamWriter | undefined;
      try {
        writer = await room.localParticipant!.streamBytes({
          topic: TOPIC_GUI,
          name: assetId,
          mimeType,
          totalSize: bytes.byteLength,
        });
        const CHUNK = 15_000;
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          await writer.write(bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength)));
        }
      } finally {
        await writer?.close().catch(() => {});
      }
    };

    const runImage = async (assetId: string, prompt: string, signal: AbortSignal): Promise<void> => {
      const res = await genai!.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });
      if (signal.aborted) return;
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType ?? 'image/png';
          await streamBytesToClient(assetId, Buffer.from(part.inlineData.data, 'base64'), mimeType);
          await publishJson(TOPIC_GUI, {
            schemaVersion: 1,
            assetId,
            type: 'image',
            status: 'ready',
            mimeType,
            streamName: assetId,
            description: prompt,
          });
          logger.info(`${ts()} [asset] image ready: ${prompt}`);
          return;
        }
      }
      throw new Error('no image returned');
    };

    const runVideo = async (assetId: string, prompt: string, signal: AbortSignal): Promise<void> => {
      let op = await genai!.models.generateVideos({
        model: 'veo-3.1-generate-preview',
        prompt,
        config: {
          aspectRatio: VIDEO_ASPECT_RATIO,
          durationSeconds: VIDEO_DURATION_SECONDS,
          resolution: VIDEO_RESOLUTION,
        },
      });
      while (!op.done) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 10_000));
        op = await genai!.operations.getVideosOperation({ operation: op });
      }
      if (signal.aborted) return;
      const video = op.response?.generatedVideos?.[0]?.video;
      if (!video?.uri) throw new Error('no video returned');
      const tmpPath = join(tmpdir(), `bodhi-${assetId}.mp4`);
      await genai!.files.download({ file: video, downloadPath: tmpPath });
      const bytes = await readFile(tmpPath);
      await unlink(tmpPath).catch(() => {});
      const mimeType = video.mimeType ?? 'video/mp4';
      await streamBytesToClient(assetId, bytes, mimeType);
      await publishJson(TOPIC_GUI, {
        schemaVersion: 1,
        assetId,
        type: 'video',
        status: 'ready',
        mimeType,
        streamName: assetId,
        description: prompt,
      });
      logger.info(`${ts()} [asset] video ready: ${prompt}`);
    };

    const startAsset = (type: 'image' | 'video', prompt: string): void => {
      const assetId = `${type}_${++assetCounter}`;
      const controller = new AbortController();
      const promise = (async () => {
        await publishJson(TOPIC_GUI, {
          schemaVersion: 1,
          assetId,
          type,
          status: 'started',
          description: prompt,
        });
        try {
          if (type === 'image') await runImage(assetId, prompt, controller.signal);
          else await runVideo(assetId, prompt, controller.signal);
        } catch (err) {
          if (!controller.signal.aborted) {
            logger.error({ err }, `${ts()} [asset] ${type} failed`);
            await publishJson(TOPIC_GUI, {
              schemaVersion: 1,
              assetId,
              type,
              status: 'error',
              error: err instanceof Error ? err.message : 'generation failed',
            });
          }
        }
      })();
      const task: AssetTask = { id: assetId, controller, promise };
      tasks.add(task);
      void promise.finally(() => tasks.delete(task)).catch(() => {});
    };

    // -- tools ----------------------------------------------------------------

    const calculate = llm.tool({
      description:
        'Evaluate a math expression. Supports + - * / ^, parentheses, sqrt, sin, cos, tan, ' +
        'log, log10, exp, abs, round, pow, and the constants pi and e.',
      parameters: z.object({
        expression: z.string().describe('The math expression, e.g. "25 * 17" or "sqrt(16)"'),
      }),
      execute: async ({ expression }) => {
        try {
          const result = evaluate(expression);
          logger.info(`${ts()} [tool] calculate: ${expression} = ${result}`);
          return { expression, result };
        } catch (err) {
          return {
            error:
              err instanceof CalculatorError
                ? err.message
                : `Could not evaluate "${expression}"`,
          };
        }
      },
    });

    const getCurrentTime = llm.tool({
      description: 'Get the current date and time. Optionally specify a timezone.',
      parameters: z.object({
        timezone: z
          .string()
          .nullable()
          .describe('IANA timezone like "America/Los_Angeles", or null for local time'),
      }),
      execute: async ({ timezone }) => {
        const now = new Date();
        try {
          const time = now.toLocaleString('en-US', {
            ...(timezone ? { timeZone: timezone } : {}),
            dateStyle: 'full',
            timeStyle: 'long',
          });
          return { timezone: timezone ?? 'local', time };
        } catch {
          return { timezone: 'UTC', time: now.toISOString() };
        }
      },
    });

    const slowWebSearch = llm.tool({
      description:
        'Search the web (demonstrates a slow, interruptible tool — takes ~3 seconds). ' +
        'Use only when the user asks for a "slow search" demo.',
      parameters: z.object({ query: z.string().describe('The search query') }),
      execute: async ({ query }, { abortSignal }) => {
        logger.info(`${ts()} [tool] slow_web_search: ${query}`);
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({ query, results: ['AI advances in 2025', 'New models released'] });
          }, 3000);
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ query, error: 'Search cancelled by user interruption' });
          });
        });
      },
    });

    const makeAssetTool = (type: 'image' | 'video') =>
      llm.tool({
        description:
          type === 'image'
            ? 'Generate an image and display it to the user. ALWAYS call this when the user wants any picture, image, card, or illustration.'
            : 'Generate a short (a few seconds) video and display it to the user. Warn them it takes a minute or two.',
        parameters: z.object({
          prompt: z.string().describe(`Detailed description of the ${type} to generate`),
        }),
        execute: async ({ prompt }, { ctx }) => {
          if (!genai) {
            return { error: 'Image/video generation is unavailable (GEMINI_API_KEY not set).' };
          }
          startAsset(type, prompt);
          ctx.session.say(
            type === 'image'
              ? "I'm making your picture now. It will appear on your screen shortly."
              : "I'm making your video now. This takes a minute or two — it will appear when it's ready.",
          );
          // Exactly one spoken acknowledgement; no follow-up LLM turn.
          throw new voice.StopResponse();
        },
      });

    const endSession = llm.tool({
      description:
        'End the voice session gracefully. Call when the user says goodbye, wants to hang up, or is done.',
      parameters: z.object({}),
      execute: async (_args, { ctx }) => {
        logger.info(`${ts()} [tool] end_session`);
        try {
          const goodbye = ctx.session.generateReply({
            instructions: 'Say a warm, brief goodbye to the user.',
            toolChoice: 'none',
          });
          await goodbye.waitForPlayout();
        } catch (err) {
          logger.warn({ err }, 'goodbye failed; shutting down anyway');
        } finally {
          await publishJson(TOPIC_SESSION, { type: 'session_end', reason: 'user_goodbye' });
          ctx.session.shutdown({ reason: 'user_initiated' });
        }
        throw new voice.StopResponse();
      },
    });

    // Mutually-referencing handoff tools; agents assigned just below.
    let mainAgent: MainAgent;
    let mathExpertAgent: MathExpertAgent;

    const talkToMathExpert = llm.tool({
      description: 'Transfer the conversation to the math specialist for harder math.',
      execute: async (): Promise<llm.AgentHandoff> => {
        logger.info(`${ts()} [transfer] main -> math_expert`);
        return llm.handoff({ agent: mathExpertAgent, returns: 'Connected to the math helper.' });
      },
    });

    const backToMain = llm.tool({
      description: 'Transfer the conversation back to the main assistant.',
      execute: async (): Promise<llm.AgentHandoff> => {
        logger.info(`${ts()} [transfer] math_expert -> main`);
        return llm.handoff({ agent: mainAgent, returns: 'Back with the main assistant.' });
      },
    });

    // NOTE: LiveKit uses the object KEYS as the tool names exposed to the model,
    // so they must match the snake_case names referenced in the instructions.
    mathExpertAgent = new MathExpertAgent({
      instructions: MATH_INSTRUCTIONS,
      tools: { calculate, back_to_main: backToMain },
    });

    mainAgent = new MainAgent({
      instructions: MAIN_INSTRUCTIONS,
      tools: {
        calculate,
        get_current_time: getCurrentTime,
        slow_web_search: slowWebSearch,
        generate_image: makeAssetTool('image'),
        generate_video: makeAssetTool('video'),
        talk_to_math_expert: talkToMathExpert,
        end_session: endSession,
      },
    });

    // -- session --------------------------------------------------------------

    const stt =
      PROVIDER === 'plugins'
        ? new deepgram.STT({ model: 'nova-3' })
        : new inference.STT({ model: 'deepgram/nova-3', language: 'en' });
    const sessionLlm =
      PROVIDER === 'plugins'
        ? new openai.LLM({ model: 'gpt-4.1-mini' })
        : new inference.LLM({ model: 'openai/gpt-4.1-mini' });
    const tts =
      PROVIDER === 'plugins'
        ? new cartesia.TTS({ model: 'sonic-3', voice: CARTESIA_VOICE_ID })
        : new inference.TTS({ model: 'cartesia/sonic-3', voice: CARTESIA_VOICE_ID });

    const session = new voice.AgentSession<UserData>({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt,
      llm: sessionLlm,
      tts,
      turnHandling: {
        // English-only EOU model (~63 MB) — lighter + faster cold start than the
        // multilingual model (~385 MB). Swap to MultilingualModel() for non-English.
        turnDetection: new livekit.turnDetector.EnglishModel(),
        preemptiveGeneration: { enabled: true },
      },
      userData: { hasGreeted: false },
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    // -- debug logging (pipeline visibility) ---------------------------------
    // Tracks the conversational state machine and data flowing through the
    // cascade, so a transcript of a run shows exactly what the agent heard,
    // thought, said, and called.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      logger.info(`${ts()} [user] ${ev.oldState} -> ${ev.newState}`);
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      logger.info(`${ts()} [agent] ${ev.oldState} -> ${ev.newState}`);
    });
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) logger.info(`${ts()} [stt] user (final): "${ev.transcript}"`);
      else logger.debug(`${ts()} [stt] user (interim): "${ev.transcript}"`);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === 'message') {
        logger.info(`${ts()} [item] ${item.role}: ${item.textContent ?? '(non-text content)'}`);
      } else if (item.type === 'agent_handoff') {
        logger.info(`${ts()} [item] handoff ${item.oldAgentId ?? '-'} -> ${item.newAgentId}`);
      }
    });
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      logger.info(`${ts()} [tools] executed: ${ev.functionCalls.map((c) => c.name).join(', ')}`);
    });
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      logger.debug(`${ts()} [speech] created (source=${ev.source}, userInitiated=${ev.userInitiated})`);
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      logger.error({ err: ev.error }, `${ts()} [error] session error`);
    });

    // Abort outstanding background tasks when the session closes.
    session.on(voice.AgentSessionEventTypes.Close, () => {
      for (const t of tasks) t.controller.abort();
      void Promise.allSettled([...tasks].map((t) => t.promise));
      logger.info(`${ts()} [session] closed; aborted ${tasks.size} background task(s)`);
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, 'session usage summary');
    });

    logger.info(`${ts()} [session] starting (provider=${PROVIDER}, gemini=${genai ? 'on' : 'off'})`);

    await session.start({
      agent: mainAgent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    logger.info(`${ts()} [session] started in room "${ctx.room.name}" — waiting for the user to speak`);
  },
});

// Explicit dispatch: the worker registers under a name, and a client's token must
// request it (see mint-token.ts roomConfig). This is deterministic — the agent always
// joins the room the token names — and avoids the "worker idle, no job dispatched" trap
// of relying on automatic dispatch. AGENT_NAME must match RoomAgentDispatch in the token.
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
