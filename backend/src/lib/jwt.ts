import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET || ''

if (!SECRET || SECRET === 'change-me-to-a-long-random-string') {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET is missing or still the example value. Refusing to start.')
    process.exit(1)
  }
}

const secret = SECRET || 'tapis-dev-secret'

export interface TokenPayload {
  id: string
  iat?: number
}

export function sign(payload: { id: string }): string {
  return jwt.sign(payload, secret, { expiresIn: '7d' })
}

export function verify(token: string): TokenPayload {
  return jwt.verify(token, secret) as TokenPayload
}
