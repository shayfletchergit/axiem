import { createClient } from "@/lib/supabase/server";
import { addClient, removeClient } from "@/lib/broker/streamBus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return new Response("Unauthorized", { status: 401 });

  const userId = user.id;
  let controller: ReadableStreamDefaultController<string>;

  const stream = new ReadableStream<string>({
    start(ctrl) {
      controller = ctrl;
      addClient(userId, ctrl);
      ctrl.enqueue(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

      const ping = setInterval(() => {
        try { ctrl.enqueue(": ping\n\n"); }
        catch { clearInterval(ping); }
      }, 25_000);
    },
    cancel() {
      removeClient(userId, controller);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
