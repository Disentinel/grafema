import { query } from '../db/pool';
import { signToken } from './jwt';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export async function getUser(id: string): Promise<User | null> {
  const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createUser(name: string, email: string): Promise<User> {
  const id = crypto.randomUUID();
  await query('INSERT INTO users (id, name, email, role) VALUES ($1, $2, $3, $4)',
    [id, name, email, 'user']);
  return { id, name, email, role: 'user' };
}

export async function login(email: string, password: string): Promise<string | null> {
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return null;
  // In real app: bcrypt compare
  return signToken(user.id);
}
