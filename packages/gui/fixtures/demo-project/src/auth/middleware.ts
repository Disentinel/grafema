import { verifyToken } from './jwt';
import { getUser } from './userService';

export interface AuthUser {
  id: string;
  name: string;
  role: string;
}

export async function authenticate(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const payload = verifyToken(token);
  if (!payload) return null;
  return getUser(payload.sub);
}

export function requireRole(role: string) {
  return async (req: Request): Promise<AuthUser | null> => {
    const user = await authenticate(req);
    if (!user || user.role !== role) return null;
    return user;
  };
}
