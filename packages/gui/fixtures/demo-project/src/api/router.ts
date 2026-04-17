import { authenticate } from '../auth/middleware';
import { getUser, createUser } from '../auth/userService';
import { query } from '../db/pool';

export interface Route {
  method: string;
  path: string;
  handler: (req: Request) => Promise<Response>;
}

export function createRouter(): Route[] {
  return [
    { method: 'GET', path: '/users/:id', handler: handleGetUser },
    { method: 'POST', path: '/users', handler: handleCreateUser },
    { method: 'GET', path: '/health', handler: handleHealth },
  ];
}

async function handleGetUser(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return new Response('Unauthorized', { status: 401 });
  const data = await getUser(user.id);
  return Response.json(data);
}

async function handleCreateUser(req: Request): Promise<Response> {
  const body = await req.json();
  const user = await createUser(body.name, body.email);
  await query('INSERT INTO audit_log (action) VALUES ($1)', ['user_created']);
  return Response.json(user, { status: 201 });
}

async function handleHealth(_req: Request): Promise<Response> {
  const result = await query('SELECT 1');
  return Response.json({ status: 'ok', db: !!result });
}
