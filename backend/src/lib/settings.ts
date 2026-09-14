import prisma from './prisma.js'
import { encrypt, decrypt, maskSecret } from './secrets.js'
import { modelFor, type Provider } from './llm/models.js'

/// Everything an operator can change without touching a file. Secrets are
/// encrypted at rest and never sent back to the browser; the environment is a
/// per-field fallback so an install configured through .env keeps working.

export type OutputLanguage = 'en' | 'ms' | 'zh'

export interface Settings {
  businessName: string
  /// Who answers the model calls. Anthropic directly, or OpenRouter.
  provider: Provider
  outputLanguage: OutputLanguage
  timezone: string
  filterModel: string
  analyzeModel: string
  /// How long a chat must be quiet before its pending messages are bundled.
  bundleQuietSeconds: number
  /// Bundle regardless of quiet once this many messages are pending.
  bundleMaxMessages: number
  /// Bundle regardless of quiet once the oldest pending is this old.
  bundleMaxWaitSeconds: number
  /// How many earlier messages the models see for context.
  contextMessages: number
  /// Let the simulator inject messages. Always on outside production.
  allowSimulation: boolean
  /// Whether inbound images are sent to the analysis model.
  analyzeImages: boolean
  /// Whether an image gets a written description (and any text read from
  /// it) before the filter sees it. Uses the filter model.
  describeImages: boolean
  /// Whether voice notes are transcribed before the filter sees them.
  transcribeVoice: boolean
  /// The model that listens. Always an OpenRouter id: Claude takes no
  /// audio, so this call goes through OpenRouter whatever the provider.
  transcribeModel: string
  /// Whether originals in a script the operator may not read (Chinese) get
  /// a translation into the output language, shown beside them.
  translateOriginals: boolean
  /// The assistant. OpenRouter ids; the loop is provider-neutral, so any
  /// model with tool calling works. `agentEscalationModel` takes over when
  /// a turn keeps failing validation — rare, so it may be a dearer model.
  agentModel: string
  agentEscalationModel: string
  agentEffort: 'low' | 'medium' | 'high'
  /// The nightly memory consolidation run.
  agentReflect: boolean
  /// The operator's own WhatsApp number — the ONLY number the assistant may
  /// ever message (see agent/guard.ts). The brief goes here; the control
  /// chat is this number's own chat on the linked account.
  operatorWaId: string
  /// The morning brief.
  agentDigest: boolean
  agentDigestHour: number
  /// The assistant over WhatsApp: the operator messaging their own number.
  agentWhatsapp: boolean
}

export interface SecretSettings {
  anthropicApiKey: string
  openrouterApiKey: string
}

export const DEFAULTS: Settings = {
  businessName: '',
  provider: 'anthropic',
  outputLanguage: 'en',
  timezone: 'Asia/Kuala_Lumpur',
  filterModel: 'claude-haiku-4-5',
  analyzeModel: 'claude-opus-5',
  bundleQuietSeconds: 60,
  bundleMaxMessages: 15,
  bundleMaxWaitSeconds: 300,
  contextMessages: 20,
  allowSimulation: false,
  analyzeImages: true,
  describeImages: true,
  transcribeVoice: true,
  transcribeModel: 'google/gemini-3.8-flash',
  translateOriginals: true,
  agentModel: 'deepseek/deepseek-v4-flash',
  agentEscalationModel: 'deepseek/deepseek-v4-pro',
  agentEffort: 'medium',
  agentReflect: true,
  operatorWaId: '',
  agentDigest: false,
  agentDigestHour: 8,
  agentWhatsapp: true,
}

export const LANGUAGE_NAMES: Record<OutputLanguage, string> = {
  en: 'English',
  ms: 'Bahasa Malaysia',
  zh: 'Chinese (Simplified)',
}

const KEY = 'settings'
const SECRET_KEY = 'secrets'

let cached: Settings | null = null
let cachedSecrets: SecretSettings | null = null

function coerce(raw: Partial<Settings> | null | undefined): Settings {
  const s = { ...DEFAULTS, ...(raw ?? {}) }
  if (!['en', 'ms', 'zh'].includes(s.outputLanguage)) s.outputLanguage = 'en'
  s.bundleQuietSeconds = clamp(s.bundleQuietSeconds, 10, 3600, DEFAULTS.bundleQuietSeconds)
  s.bundleMaxMessages = clamp(s.bundleMaxMessages, 3, 100, DEFAULTS.bundleMaxMessages)
  s.bundleMaxWaitSeconds = clamp(s.bundleMaxWaitSeconds, 30, 7200, DEFAULTS.bundleMaxWaitSeconds)
  s.contextMessages = clamp(s.contextMessages, 0, 60, DEFAULTS.contextMessages)
  if (!['anthropic', 'openrouter', 'mock'].includes(s.provider)) s.provider = 'anthropic'
  // The mock is a development tool. Production never runs it.
  if (s.provider === 'mock' && process.env.NODE_ENV === 'production') s.provider = 'anthropic'
  if (!s.transcribeModel) s.transcribeModel = DEFAULTS.transcribeModel
  if (!s.agentModel) s.agentModel = DEFAULTS.agentModel
  if (!s.agentEscalationModel) s.agentEscalationModel = DEFAULTS.agentEscalationModel
  if (!['low', 'medium', 'high'].includes(s.agentEffort)) s.agentEffort = DEFAULTS.agentEffort
  s.agentDigestHour = clamp(s.agentDigestHour, 0, 23, DEFAULTS.agentDigestHour)
  // Settings saved before the rule had one field carried the number as
  // the digest destination; that becomes the operator's number.
  const legacy = (raw as { agentDigestTo?: string } | null | undefined)?.agentDigestTo
  s.operatorWaId = String(s.operatorWaId || legacy || '').replace(/[^0-9]/g, '')
  if (!s.filterModel) s.filterModel = DEFAULTS.filterModel
  if (!s.analyzeModel) s.analyzeModel = DEFAULTS.analyzeModel
  // A known model keeps working when the provider changes under it.
  s.filterModel = modelFor(s.filterModel, s.provider)
  s.analyzeModel = modelFor(s.analyzeModel, s.provider)
  return s
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export async function loadSettings(): Promise<Settings> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
    cached = coerce(row?.value as Partial<Settings> | null)
  } catch {
    cached = coerce(null)
  }
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SECRET_KEY } })
    const v = (row?.value ?? {}) as Record<string, string>
    cachedSecrets = {
      anthropicApiKey: v.anthropicApiKey ? (decrypt(v.anthropicApiKey) ?? '') : '',
      openrouterApiKey: v.openrouterApiKey ? (decrypt(v.openrouterApiKey) ?? '') : '',
    }
  } catch {
    cachedSecrets = { anthropicApiKey: '', openrouterApiKey: '' }
  }
  return cached
}

/// Sync on purpose: read on every pipeline tick and every send.
export function settings(): Settings {
  return cached ?? coerce(null)
}

export function simulationAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || settings().allowSimulation
}

export type SecretName = keyof SecretSettings

const ENV_FOR: Record<SecretName, string> = { anthropicApiKey: 'ANTHROPIC_API_KEY', openrouterApiKey: 'OPENROUTER_API_KEY' }

/// The stored key wins; the environment is the fallback.
export function secret(name: SecretName): string {
  return cachedSecrets?.[name] || process.env[ENV_FOR[name]] || ''
}

export function secretSource(name: SecretName): 'settings' | 'env' | 'none' {
  if (cachedSecrets?.[name]) return 'settings'
  if (process.env[ENV_FOR[name]]) return 'env'
  return 'none'
}

/// The key the current provider needs.
export function providerApiKey(): string {
  const p = settings().provider
  if (p === 'mock') return 'mock'
  return p === 'openrouter' ? secret('openrouterApiKey') : secret('anthropicApiKey')
}

/// Transcription is the one call that cannot use the Anthropic key.
export function transcriptionConfigured(): boolean {
  const p = settings().provider
  if (p === 'mock') return true
  return !!secret('openrouterApiKey')
}

export function mockAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = coerce({ ...settings(), ...patch })
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as object },
    update: { value: next as object },
  })
  cached = next
  return next
}

async function writeSecrets() {
  const value: Record<string, string> = {}
  for (const name of Object.keys(ENV_FOR) as SecretName[]) {
    const v = cachedSecrets?.[name]
    if (v) value[name] = encrypt(v)
  }
  await prisma.appSetting.upsert({ where: { key: SECRET_KEY }, create: { key: SECRET_KEY, value }, update: { value } })
}

/// Empty means "leave it alone"; clearing needs an explicit call.
export async function saveSecret(name: SecretName, value: string): Promise<void> {
  if (!value) return
  cachedSecrets = { anthropicApiKey: '', openrouterApiKey: '', ...(cachedSecrets ?? {}), [name]: value }
  await writeSecrets()
}

export async function clearSecret(name: SecretName): Promise<void> {
  cachedSecrets = { anthropicApiKey: '', openrouterApiKey: '', ...(cachedSecrets ?? {}), [name]: '' }
  await writeSecrets()
}

function keyView(name: SecretName) {
  const v = secret(name)
  return { configured: !!v, source: secretSource(name), hint: maskSecret(v) }
}

export function publicSettings() {
  return {
    ...settings(),
    keys: { anthropic: keyView('anthropicApiKey'), openrouter: keyView('openrouterApiKey') },
    simulationAllowed: simulationAllowed(),
    mockAllowed: mockAllowed(),
  }
}
