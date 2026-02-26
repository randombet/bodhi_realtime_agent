// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Gemini Realtime Voice Agent with Tools
 *
 * This example demonstrates a real-time voice assistant using LiveKit Agents framework with:
 * - Gemini Realtime API: Native audio model with server-side turn detection
 * - Google Search: Built-in Gemini grounding tool for live web search
 * - Custom function tools: Calculator, current time, slow search demo
 * - Multi-agent: Agent transfer between main assistant and math expert
 *
 * Usage:
 *   1. Set GOOGLE_API_KEY and LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET
 *   2. Run: pnpm tsx examples/src/gemini_realtime_tools.ts dev
 *   3. Connect via LiveKit playground or SDK
 *   4. Try: "Search for the latest AI news", "What's 25 times 17?",
 *           "I need help with complex math" (triggers agent transfer)
 */

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// =============================================================================
// User Data Type
// =============================================================================

type UserData = {
  calculationHistory: string[];
};

// =============================================================================
// Agent Storage (for transfer between agents)
// =============================================================================

const agents: Record<string, voice.Agent<UserData>> = {};

// =============================================================================
// Custom Tools
// =============================================================================
// Tools follow these patterns:
// 1. Fast tools: Return immediately (calculate, get_current_time)
// 2. Slow tools: May take time, can be interrupted (slow_web_search)
// =============================================================================

/**
 * Calculator tool - evaluates mathematical expressions
 */
const calculate = llm.tool({
  description: `Evaluate a mathematical expression.
Supports: sqrt, sin, cos, tan, log, log10, exp, abs, round, pow, pi, e
Examples: "2 + 2", "sqrt(16)", "sin(pi/2)", "pow(2, 10)"`,
  parameters: z.object({
    expression: z.string().describe('The mathematical expression to evaluate'),
  }),
  execute: async ({ expression }, { ctx }: llm.ToolOptions<UserData>) => {
    // Safe math evaluation using a restricted set of functions
    const mathFunctions: Record<string, unknown> = {
      sqrt: Math.sqrt,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      log: Math.log,
      log10: Math.log10,
      exp: Math.exp,
      abs: Math.abs,
      round: Math.round,
      pow: Math.pow,
      pi: Math.PI,
      e: Math.E,
      PI: Math.PI,
      E: Math.E,
    };

    try {
      // Create a safe evaluation context
      const safeExpression = expression.replace(
        /\b(sqrt|sin|cos|tan|log|log10|exp|abs|round|pow|pi|PI|e|E)\b/g,
        (match) => `mathFunctions.${match.toLowerCase()}`,
      );

      // Use Function constructor for controlled evaluation
      const fn = new Function('mathFunctions', `return ${safeExpression}`);
      const result = fn(mathFunctions);

      // Track calculation history
      ctx.userData.calculationHistory.push(`${expression} = ${result}`);

      return `The result of ${expression} is ${result}`;
    } catch (error) {
      return `Error evaluating "${expression}": ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
});

/**
 * Current time tool - returns current date/time
 */
const getCurrentTime = llm.tool({
  description: 'Get the current date and time. Optionally specify a timezone.',
  parameters: z.object({
    timezone: z
      .string()
      .optional()
      .describe('Timezone name (e.g., "UTC", "America/Los_Angeles"). Defaults to local time.'),
  }),
  execute: async ({ timezone }) => {
    try {
      const now = new Date();
      if (timezone) {
        const formatted = now.toLocaleString('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        });
        return `The time in ${timezone} is ${formatted}`;
      } else {
        return `The local time is ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' })}`;
      }
    } catch (error) {
      // Fallback to UTC if timezone is invalid
      const now = new Date();
      return `The UTC time is ${now.toISOString()}`;
    }
  },
});

/**
 * Slow web search tool - demonstrates handling of slow operations
 *
 * This simulates a slow API call. The framework handles the flow:
 * - Agent can speak while this runs
 * - User can interrupt
 * - Result is spoken when ready
 */
const slowWebSearch = llm.tool({
  description: `Search the web for information (demonstrates slow tool handling).
This tool simulates a slow web search that takes 3 seconds.
Use this when the user specifically asks for a "slow search" demo.`,
  parameters: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async ({ query }, { abortSignal }) => {
    console.log(`[Tool] slow_web_search starting for: ${query}`);

    // Simulate API delay with abort support
    const searchPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve(
          `Top results for '${query}': 1) AI advances in 2024, 2) New language models released, 3) Major tech announcements`,
        );
      }, 3000);

      // Handle abort signal
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('Search cancelled'));
        });
      }
    });

    try {
      const result = await searchPromise;
      console.log(`[Tool] slow_web_search completed for: ${query}`);
      return result;
    } catch {
      console.log(`[Tool] slow_web_search interrupted for: ${query}`);
      return null; // Return null to skip tool reply
    }
  },
});

// =============================================================================
// Agent Transfer Tools
// =============================================================================

/**
 * Transfer back to main agent tool
 */
const transferToMainAgent = llm.tool({
  description: `Transfer the conversation back to the main assistant.
Use this when you've finished helping with the specialized task
and the user wants general assistance again.`,
  execute: async () => {
    console.log('[Transfer] Returning to main agent');
    return llm.handoff({
      agent: agents['main']!,
      returns: 'Transferring you back to the main assistant.',
    });
  },
});

/**
 * Transfer to math expert tool
 */
const transferToMathExpert = llm.tool({
  description: `Transfer the conversation to a math specialist.
Use this when the user has complex math questions or needs
detailed mathematical explanations beyond simple calculations.`,
  execute: async () => {
    console.log('[Transfer] Transferring to math expert');
    return llm.handoff({
      agent: agents['math_expert']!,
      returns: 'Transferring you to our math expert who can help with complex calculations.',
    });
  },
});

// =============================================================================
// Agent Definitions
// =============================================================================

/**
 * Math Expert Agent - specialized for complex calculations
 * Uses a different voice (Charon) and lower temperature for precision
 */
class MathExpertAgent extends voice.Agent<UserData> {
  async onEnter() {
    this.session.generateReply({
      instructions:
        'Introduce yourself briefly as the math expert and ask how you can help with their math question.',
      toolChoice: 'none', // Prevent tool calls during greeting
    });
  }

  static create(apiKey?: string) {
    return new MathExpertAgent({
      instructions: `You are a MATH EXPERT assistant. You speak with confidence about mathematics.

Your specialty is:
- Complex mathematical calculations
- Explaining mathematical concepts
- Step-by-step problem solving
- Statistical analysis

Guidelines:
- ALWAYS respond in English
- Be precise and accurate
- Explain your reasoning step by step
- Use the calculate tool for actual computation
- When the user is done with math questions, offer to transfer them back to the main assistant
- Use transfer_to_main_agent when the user wants general help

You have a more serious, professorial tone compared to the main assistant.`,
      llm: new google.beta.realtime.RealtimeModel({
        apiKey,
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voice: 'Charon', // Different voice for math expert
        temperature: 0.3, // Lower temperature for precise math
        thinkingConfig: {
          includeThoughts: false,
        },
      }),
      tools: {
        calculate,
        transfer_to_main_agent: transferToMainAgent,
      },
    });
  }
}

/**
 * Main Agent - general purpose assistant with tools and transfer capability
 */
class MainAgent extends voice.Agent<UserData> {
  async onEnter() {
    this.session.generateReply({
      instructions:
        'Greet the user briefly in English. Mention you can search the web, do math, tell the time, and transfer to a math expert for complex calculations. Keep it short and friendly.',
      toolChoice: 'none', // Prevent tool calls during greeting
    });
  }

  static create(apiKey?: string) {
    return new MainAgent({
      instructions: `You are a helpful voice assistant. ALWAYS respond in English.

You have access to:
1. **Google Search**: Built-in Gemini web search for current information (use naturally when user asks factual questions)
2. **Calculator**: Evaluate math expressions (sqrt, sin, cos, log, pi, etc.)
3. **Current Time**: Get the current date and time in any timezone
4. **Slow Web Search**: Demo tool that takes 3 seconds - shows how the framework handles slow operations
5. **Math Expert Transfer**: Transfer to a specialized math expert for complex calculations

Guidelines:
- ALWAYS speak in English, regardless of what language the user speaks
- Be conversational and friendly
- Keep responses concise (this is voice)
- Use Google Search for factual questions or current events
- Use calculator for simple math
- For COMPLEX math questions or when the user wants detailed mathematical explanations,
  use transfer_to_math_expert to hand them off to our math specialist
- When using slow_web_search, tell the user you're searching while you wait for results`,
      llm: new google.beta.realtime.RealtimeModel({
        apiKey,
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voice: 'Puck',
        temperature: 0.8,
        thinkingConfig: {
          includeThoughts: false,
        },
        // Enable Google Search grounding
        geminiTools: {
          googleSearch: {},
        },
      }),
      tools: {
        calculate,
        get_current_time: getCurrentTime,
        slow_web_search: slowWebSearch,
        transfer_to_math_expert: transferToMathExpert,
      },
    });
  }
}

// =============================================================================
// Agent Entry Point
// =============================================================================

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Load VAD model once during worker startup
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    // Initialize user data
    const userData: UserData = {
      calculationHistory: [],
    };

    // Get API key from environment
    const apiKey = process.env.GOOGLE_API_KEY;

    // Create agents and store in registry for transfer
    agents['main'] = MainAgent.create(apiKey);
    agents['math_expert'] = MathExpertAgent.create(apiKey);

    // Create agent session
    // NOTE: No session-level LLM needed - each agent provides its own RealtimeModel
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      userData,
    });

    // Set up event handlers
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        console.log(`You: ${ev.transcript}`);
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      for (const [call] of voice.zipFunctionCallsAndOutputs(ev)) {
        console.log(`[Tool] ${call.name}`);
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[Agent State] ${ev.oldState} -> ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error(`[Error] ${ev.error}`);
    });

    // Start the session with the main agent
    await session.start({
      agent: agents['main']!,
      room: ctx.room,
    });

    console.log('============================================================');
    console.log('Gemini Voice Assistant Ready!');
    console.log('============================================================');
    console.log();
    console.log('Try saying:');
    console.log("  - 'What time is it?'");
    console.log("  - 'What is 25 times 17?'");
    console.log("  - 'Search for the latest AI news'");
    console.log("  - 'I need help with complex math' (transfers to math expert!)");
    console.log("  - 'Use slow search for AI news'");
    console.log('============================================================');
    console.log();

    // Wait for participant
    const participant = await ctx.waitForParticipant();
    console.log('Participant joined:', participant.identity);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
