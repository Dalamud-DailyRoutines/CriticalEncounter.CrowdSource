import { hasDataCenter } from "./catalog";
import type { Env } from "./models";
import { jsonError } from "./validation";

export async function handleRealtime(request: Request, env: Env, dataCenterID: number): Promise<Response> {
  if (!hasDataCenter(dataCenterID)) return jsonError("unsupported_data_center", 404);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return jsonError("websocket_required", 426);

  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin)
    return jsonError("invalid_origin", 403);

  const id = env.DATA_CENTER_STATE.idFromName(`dc:${dataCenterID}`);
  const durableObject = env.DATA_CENTER_STATE.get(id);
  const headers = new Headers(request.headers);

  return durableObject.fetch(`https://internal/internal/realtime/${dataCenterID}`, { headers });
}
