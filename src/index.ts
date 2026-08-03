import { DataCenterState } from "./durable-objects/DataCenterState";
import type { Env } from "./models";
import { handleRealtime } from "./realtime";
import { handleUpload } from "./upload";
import { jsonError } from "./validation";

export { DataCenterState };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return Response.json({ status: "ok", serverTime: Math.floor(Date.now() / 1000) });

    if (url.pathname === "/v1/reports")
      return handleUpload(request, env);

    const realtimeMatch = url.pathname.match(/^\/v1\/realtime\/(\d+)$/);
    if (realtimeMatch)
      return handleRealtime(request, env, Number(realtimeMatch[1]));

    if (url.pathname.startsWith("/v1/"))
      return jsonError("not_found", 404);

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
