import prisma from '../prisma.js'
import { settings } from '../settings.js'

/// The one rule that is not a preference: the assistant may message ONE
/// WhatsApp number — the operator's own, as typed on Settings — and no
/// other. Every path by which the assistant's words could reach a phone
/// goes through here: the send tools, the item send, the morning brief,
/// the control-chat replies, and rules it writes with WhatsApp
/// destinations. There is no approval that lifts it; only the operator
/// changing the number on Settings does.

export function operatorNumber(): string {
  return settings().operatorWaId
}

export function isOperatorNumber(to: string, op = operatorNumber()): boolean {
  const n = to.replace(/[^0-9]/g, '')
  return !!op && n === op
}

/// Throws for any recipient but the operator. The message names the rule
/// so the model can explain it instead of trying another way round.
export function assertOperatorNumber(to: string, op = operatorNumber()): string {
  const n = to.replace(/[^0-9]/g, '')
  if (!op) throw new Error('The assistant has no number it may message. Set "Your own number" on Settings first.')
  if (n !== op) throw new Error(`The assistant may only message the operator's own number (+${op}); it can never message +${n || to}. This is a fixed rule, not something to approve.`)
  return n
}

/// The indirect path: the pipeline delivers items to the numbers on a
/// rule. A tool that makes the pipeline run for a chat whose active rules
/// name anyone but the operator would have the assistant cause a text to
/// someone else — so it refuses, and says which rule. The operator can run
/// it from the screens, where it is their own act.
export async function assertNoOutsideDeliveries(chatId?: string): Promise<void> {
  const op = operatorNumber()
  const rules = await prisma.rule.findMany({
    where: { active: true, ...(chatId ? { chatId } : { chat: { tracked: true } }) },
    select: { id: true, text: true, toWhatsapp: true, chat: { select: { name: true } } },
  })
  const offending = rules.filter((r) => r.toWhatsapp.some((n) => n !== op))
  if (!offending.length) return
  const r = offending[0]
  throw new Error(
    `Refused: running the pipeline here would send items to +${r.toWhatsapp.find((n) => n !== op)} under the rule "${r.text.slice(0, 60)}" (${r.chat.name}). The assistant may only cause messages to the operator's own number. The operator can run it from the Chats screen.`,
  )
}
