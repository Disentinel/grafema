const SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface TokenPayload {
  sub: string;
  exp: number;
}

export function signToken(userId: string): string {
  const payload: TokenPayload = {
    sub: userId,
    exp: Date.now() + 3600_000,
  };
  return btoa(JSON.stringify(payload)) + '.' + btoa(SECRET);
}

export function verifyToken(token: string): TokenPayload | null {
  const [payloadB64, sigB64] = token.split('.');
  if (btoa(SECRET) !== sigB64) return null;
  const payload: TokenPayload = JSON.parse(atob(payloadB64));
  if (payload.exp < Date.now()) return null;
  return payload;
}
