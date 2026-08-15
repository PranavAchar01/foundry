import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

/**
 * The brain, behind a flag.
 *
 * Foundry's reasoning ran on Anthropic only, which made the whole portfolio
 * hostage to one account's credit balance. This is the ninth swappable
 * capability: `FOUNDRY_BRAIN_PROVIDER=anthropic|openai` picks the model that
 * thinks, and everything above it — hypotheses, allocation judgements, the
 * operator agent — is written against this interface rather than a vendor SDK.
 *
 * Two shapes cover every call site:
 *   structured() — one forced tool call, for guaranteed-shape output
 *   converse()   — a turn of an agentic loop that may call tools
 *
 * The transcript type is provider-neutral; each brain translates it.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  schema: JsonSchema;
}

export interface BrainToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BrainToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export type BrainMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: BrainToolCall[] }
  | { role: 'tool'; results: BrainToolResult[] };

export interface BrainTurn {
  text: string;
  toolCalls: BrainToolCall[];
  model: string;
}

export interface Brain {
  readonly info: {
    capability: 'brain';
    name: string;
    configured: boolean;
    requires: string[];
    model: string;
  };
  /** One forced tool call. Throws if the model does not produce one. */
  structured<T>(opts: {
    system: string;
    prompt: string;
    tool: ToolSpec;
    maxTokens?: number;
  }): Promise<{ value: T; model: string }>;
  /** One assistant turn that may request tools. */
  converse(opts: {
    system: string;
    messages: BrainMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<BrainTurn>;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

export class AnthropicBrain implements Brain {
  readonly info = {
    capability: 'brain' as const,
    name: 'anthropic',
    configured: Boolean(env.anthropicApiKey),
    requires: ['ANTHROPIC_API_KEY'],
    model: env.model,
  };

  private client(): Anthropic {
    if (!anthropicClient) {
      if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });
    }
    return anthropicClient;
  }

  private tool(spec: ToolSpec): Anthropic.Tool {
    return {
      name: spec.name,
      description: spec.description,
      input_schema: spec.schema as Anthropic.Tool.InputSchema,
    };
  }

  private transcript(messages: BrainMessage[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (m.role === 'user') return { role: 'user' as const, content: m.text };
      if (m.role === 'assistant') {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.text) blocks.push({ type: 'text', text: m.text });
        for (const call of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        }
        return { role: 'assistant' as const, content: blocks };
      }
      return {
        role: 'user' as const,
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      };
    });
  }

  async structured<T>(opts: {
    system: string;
    prompt: string;
    tool: ToolSpec;
    maxTokens?: number;
  }): Promise<{ value: T; model: string }> {
    const res = await this.client().messages.create({
      model: env.model,
      max_tokens: opts.maxTokens ?? 1600,
      system: opts.system,
      tools: [this.tool(opts.tool)],
      tool_choice: { type: 'tool', name: opts.tool.name },
      messages: [{ role: 'user', content: opts.prompt }],
    });
    const block = res.content.find((c) => c.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('model returned no tool_use block');
    return { value: block.input as T, model: res.model };
  }

  async converse(opts: {
    system: string;
    messages: BrainMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<BrainTurn> {
    const res = await this.client().messages.create({
      model: env.model,
      max_tokens: opts.maxTokens ?? 2000,
      system: opts.system,
      tools: opts.tools.map((t) => this.tool(t)),
      messages: this.transcript(opts.messages),
    });
    return {
      text: res.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      toolCalls: res.content
        .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
        .map((c) => ({ id: c.id, name: c.name, input: c.input as Record<string, unknown> })),
      model: res.model,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }[];
  error?: { message?: string };
}

export class OpenAiBrain implements Brain {
  readonly info = {
    capability: 'brain' as const,
    name: 'openai',
    configured: Boolean(env.openaiApiKey),
    requires: ['OPENAI_API_KEY'],
    model: env.openaiModel,
  };

  constructor(
    private readonly apiKey = env.openaiApiKey,
    private readonly model = env.openaiModel,
  ) {}

  /**
   * OpenAI's strict function schema rejects free-form objects, so every schema
   * is normalised: `additionalProperties: false` everywhere, and every property
   * listed as required (strict mode's rule — optionality is expressed by the
   * model returning an empty value, which the callers already tolerate).
   */
  private normalise(schema: JsonSchema): JsonSchema {
    const walk = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(walk);
      if (!node || typeof node !== 'object') return node;
      const obj = { ...(node as Record<string, unknown>) };
      if (obj.type === 'object' && obj.properties) {
        obj.additionalProperties = false;
        obj.properties = Object.fromEntries(
          Object.entries(obj.properties as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
        );
        obj.required = Object.keys(obj.properties as Record<string, unknown>);
      }
      if (obj.items) obj.items = walk(obj.items);
      return obj;
    };
    return walk(schema) as JsonSchema;
  }

  private tool(spec: ToolSpec) {
    return {
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: this.normalise(spec.schema),
      },
    };
  }

  private transcript(messages: BrainMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: m.text || null,
          ...(m.toolCalls.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        });
      } else {
        // OpenAI wants one message per tool result, not a batched block.
        for (const r of m.results) {
          out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        }
      }
    }
    return out;
  }

  private async call(body: Record<string, unknown>): Promise<OpenAiResponse> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, ...body }),
      });
      if (res.ok) return (await res.json()) as OpenAiResponse;

      const text = await res.text().catch(() => '');
      lastError = `${res.status} ${text.slice(0, 200)}`;
      // 429 and 5xx are worth another try; 4xx are not.
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
    throw new Error(`openai: ${lastError}`);
  }

  private parseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async structured<T>(opts: {
    system: string;
    prompt: string;
    tool: ToolSpec;
    maxTokens?: number;
  }): Promise<{ value: T; model: string }> {
    const res = await this.call({
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.prompt },
      ],
      tools: [this.tool(opts.tool)],
      tool_choice: { type: 'function', function: { name: opts.tool.name } },
      // Reasoning models spend tokens before the tool call, so this is
      // deliberately generous — too small and the call never arrives.
      max_completion_tokens: Math.max(opts.maxTokens ?? 1600, 3000),
    });

    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      throw new Error(
        `openai returned no tool call (finish_reason=${res.choices?.[0]?.finish_reason ?? 'none'})`,
      );
    }
    return { value: this.parseArgs(call.function.arguments) as T, model: res.model ?? this.model };
  }

  async converse(opts: {
    system: string;
    messages: BrainMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<BrainTurn> {
    const res = await this.call({
      messages: [{ role: 'system', content: opts.system }, ...this.transcript(opts.messages)],
      tools: opts.tools.map((t) => this.tool(t)),
      max_completion_tokens: Math.max(opts.maxTokens ?? 2000, 3000),
    });

    const message = res.choices?.[0]?.message;
    return {
      text: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        input: this.parseArgs(c.function.arguments),
      })),
      model: res.model ?? this.model,
    };
  }
}

// ---------------------------------------------------------------------------

export const BRAIN_IMPLEMENTATIONS: Record<string, () => Brain> = {
  anthropic: () => new AnthropicBrain(),
  openai: () => new OpenAiBrain(),
};

/**
 * Explicit flag wins. Otherwise prefer Anthropic when it has a key, and fall
 * back to OpenAI — so an unset flag still resolves to something that works.
 */
export function brain(name = env.brainProvider): Brain {
  const make = BRAIN_IMPLEMENTATIONS[name];
  if (make) return make();
  return env.anthropicApiKey ? new AnthropicBrain() : new OpenAiBrain();
}
