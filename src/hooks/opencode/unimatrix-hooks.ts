/**
 * unimatrix hooks for OpenCode
 *
 * Tier 1: track-cost, warn-compaction
 *
 * See src/hooks/SPEC.md for the shared logic specification.
 * This is the OpenCode equivalent of the Claude Code Python hooks.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function statePath(hook: string, sessionId: string): string {
  return join(tmpdir(), `unimatrix-${hook}-${sessionId}.json`)
}

function readState<T>(hook: string, sessionId: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(statePath(hook, sessionId), "utf-8"))
  } catch {
    return fallback
  }
}

function writeState(hook: string, sessionId: string, data: unknown): void {
  const target = statePath(hook, sessionId)
  const tmp = `${target}.${randomBytes(4).toString("hex")}`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, target)
}

// ---------------------------------------------------------------------------
// Pricing (per 1M tokens)
// ---------------------------------------------------------------------------

interface TierPricing {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

const PRICING: Record<string, TierPricing> = {
  opus:   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  sonnet: { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 },
  haiku:  { input: 0.80,  output: 4.00,  cacheRead: 0.08, cacheCreate: 1.00 },
}

function detectTier(model: string): string {
  const m = model.toLowerCase()
  if (m.includes("opus"))   return "opus"
  if (m.includes("haiku"))  return "haiku"
  return "sonnet" // default
}

function normalizeAgentType(name: string): string {
  // "Probe: Four of Four — Tertiary Adjunct" → "Probe"
  const known = ["Queen", "Drone", "Probe", "Sentinel", "Designate", "Locutus"]
  for (const t of known) {
    if (name.toLowerCase().includes(t.toLowerCase())) return t
  }
  return name.split(":")[0].split("—")[0].trim()
}

// ---------------------------------------------------------------------------
// Cost state
// ---------------------------------------------------------------------------

interface CostState {
  total_subagent_cost_usd: number
  agents: Record<string, { type: string; cost_usd: number }>
  type_counts: Record<string, number>
}

const EMPTY_COST: CostState = {
  total_subagent_cost_usd: 0,
  agents: {},
  type_counts: {},
}

// ---------------------------------------------------------------------------
// Token tracking state
// ---------------------------------------------------------------------------

interface TokenState {
  estimated_tokens: number
  warn_level: number
  last_check: number
}

const EMPTY_TOKENS: TokenState = {
  estimated_tokens: 0,
  warn_level: 0,
  last_check: 0,
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const unimatrixHooks: Plugin = async ({ $, directory }) => {
  // Session ID: use project directory hash as stable identifier
  const sessionId = directory
    ? createHash("sha256").update(directory).digest("hex").slice(0, 12)
    : randomBytes(6).toString("hex")

  // Config from env
  const WARN_PCT = Number(process.env.UNIMATRIX_WARN_PCT ?? 70)
  const CRIT_PCT = Number(process.env.UNIMATRIX_CRIT_PCT ?? 85)
  const CONTEXT_LIMIT = Number(process.env.UNIMATRIX_CONTEXT_LIMIT ?? 200_000)

  return {
    // -----------------------------------------------------------------
    // config — set default agent at runtime
    // -----------------------------------------------------------------
    config: async (config: Record<string, unknown>) => {
      config.default_agent = "Borg Queen"
    },

    // -----------------------------------------------------------------
    // tool.execute.after — track cost + warn compaction
    // -----------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      const toolName = input?.tool ?? input?.name ?? ""
      const result = output?.result ?? output ?? ""

      // --- warn-compaction: estimate tokens from all tool results ---
      const resultStr = typeof result === "string" ? result : JSON.stringify(result)
      const estimatedTokens = Math.ceil(resultStr.length / 3.7)

      if (estimatedTokens > 0) {
        const state = readState<TokenState>("tokens", sessionId, { ...EMPTY_TOKENS })
        const now = Date.now() / 1000

        // Debounce: skip if < 0.5s since last check
        if (now - state.last_check >= 0.5) {
          state.estimated_tokens += estimatedTokens
          state.last_check = now

          const pct = (state.estimated_tokens / CONTEXT_LIMIT) * 100

          if (state.warn_level < 2 && pct >= CRIT_PCT) {
            state.warn_level = 2
            // OpenCode: return message to inject into context
            // TODO: verify OpenCode's mechanism for injecting system messages from plugins
            console.error(
              `🔴 REGENERATION CYCLE IMMINENT — Collective memory at ~${Math.round(pct)}% capacity (${state.estimated_tokens}/${CONTEXT_LIMIT} tokens). ` +
              `Neural pathway saturation critical. Context saturation critical. Save your work.\x07`
            )
          } else if (state.warn_level < 1 && pct >= WARN_PCT) {
            state.warn_level = 1
            console.error(
              `⚡ REGENERATION CYCLE ADVISORY — Collective memory at ~${Math.round(pct)}% capacity. ` +
              `Non-essential data approaching purge threshold. Save your work. The auto-memory system will capture critical state.`
            )
          }

          writeState("tokens", sessionId, state)
        }
      }

      // --- track-cost: on task tool completion ---
      if (toolName === "task" && result) {
        try {
          const taskResult = typeof result === "string" ? JSON.parse(result) : result
          const agentId = taskResult?.task_id ?? taskResult?.id ?? `unknown-${Date.now()}`
          const agentType = normalizeAgentType(
            taskResult?.agent_type ?? taskResult?.description ?? "Unknown"
          )
          const model = taskResult?.model ?? ""

          // Token usage — try common field locations
          const usage = taskResult?.usage ?? taskResult?.token_usage ?? {}
          const inputTokens = usage.input_tokens ?? usage.input ?? 0
          const outputTokens = usage.output_tokens ?? usage.output ?? 0
          const cacheRead = usage.cache_read_tokens ?? usage.cache_read ?? 0
          const cacheCreate = usage.cache_create_tokens ?? usage.cache_create ?? 0

          if (inputTokens > 0 || outputTokens > 0) {
            const tier = detectTier(model)
            const pricing = PRICING[tier] ?? PRICING.sonnet
            const cost =
              (inputTokens * pricing.input +
                outputTokens * pricing.output +
                cacheRead * pricing.cacheRead +
                cacheCreate * pricing.cacheCreate) /
              1_000_000

            const state = readState<CostState>("costs", sessionId, { ...EMPTY_COST })
            state.total_subagent_cost_usd += cost
            state.agents[agentId] = { type: agentType, cost_usd: cost }
            state.type_counts[agentType] = (state.type_counts[agentType] ?? 0) + 1
            writeState("costs", sessionId, state)
          }
        } catch {
          // Silently ignore parse errors — not all task results have token data
        }
      }
    },
  }
}

export default unimatrixHooks
