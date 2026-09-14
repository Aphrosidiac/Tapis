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
