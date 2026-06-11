import type { Execution } from "./types";

export async function relayExecutions(
  axiemUrl: string,
  secret: string,
  executions: Execution[],
): Promise<void> {
  if (executions.length === 0) return;

  const res = await fetch(`${axiemUrl}/api/webhook/execution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-axiem-secret": secret,
    },
    body: JSON.stringify({ executions }),
  });

  if (!res.ok) {
    throw new Error(`Webhook rejected: ${res.status}`);
  }
}
