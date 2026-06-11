// Per-user SSE broadcast bus. Keyed by Supabase user ID.
// Uses globalThis to survive Next.js dev hot-module-replacement.

type Controller = ReadableStreamDefaultController<string>;

const g = globalThis as typeof globalThis & { _axiemClients?: Map<string, Set<Controller>> };
if (!g._axiemClients) g._axiemClients = new Map<string, Set<Controller>>();
const clients = g._axiemClients;

export function addClient(userId: string, ctrl: Controller): void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(ctrl);
  console.log(`[streamBus] +client uid=${userId} total=${clients.get(userId)!.size}`);
}

export function removeClient(userId: string, ctrl: Controller): void {
  clients.get(userId)?.delete(ctrl);
}

export function broadcast(userId: string, payload: object): void {
  const userClients = clients.get(userId);
  console.log(`[streamBus] broadcast uid=${userId} clients=${userClients?.size ?? 0}`);
  if (!userClients?.size) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const ctrl of userClients) {
    try { ctrl.enqueue(msg); }
    catch { userClients.delete(ctrl); }
  }
}
