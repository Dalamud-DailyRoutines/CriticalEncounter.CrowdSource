import { getAreaForTerritory, getServerGroupForDataCenter, hasDataCenter } from "./catalog";
import type { Env, SubscriptionRequest } from "./models";
import { jsonError, readBody } from "./validation";

export async function handleSubscriptions(request: Request, env: Env): Promise<Response> {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "86400",
    "cache-control": "no-store"
  };

  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });

  let response: Response;
  try {
    response = await subscribe(request, env);
  } catch (error) {
    console.error(JSON.stringify({ event: "subscription.failed", error: String(error) }));
    response = jsonError("subscription_unavailable", 503);
    response.headers.set("retry-after", "30");
  }
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers))
    result.headers.set(name, value);
  return result;
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return jsonError("content_type_required", 400);

  const { success } = await env.SUBSCRIPTION_RATE_LIMITER.limit({
    key: request.headers.get("cf-connecting-ip") ?? "unknown"
  });
  if (!success) {
    const response = jsonError("rate_limited", 429);
    response.headers.set("retry-after", "60");
    return response;
  }

  const text = await readBody(request);
  if (text === undefined) return jsonError("payload_too_large", 413);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (!payload || typeof payload !== "object") return jsonError("invalid_payload", 400);
  const body = payload as Partial<SubscriptionRequest>;
  if (!Number.isSafeInteger(body.dataCenterID) || !hasDataCenter(body.dataCenterID!))
    return jsonError("unsupported_data_center", 400);
  if (!Array.isArray(body.instances) || body.instances.length < 1 || body.instances.length > 32)
    return jsonError("invalid_instance_count", 400);

  const serverGroup = getServerGroupForDataCenter(body.dataCenterID!);
  const seen = new Set<string>();
  for (const target of body.instances) {
    if (!target || !Number.isSafeInteger(target.instanceID) || target.instanceID < 1 ||
        target.instanceID > 4294967295 || !Number.isSafeInteger(target.territoryID))
      return jsonError("invalid_instance", 400);
    const area = getAreaForTerritory(target.territoryID);
    if (!area || !area.serverGroups.includes(serverGroup!))
      return jsonError("unsupported_territory_for_server", 400);
    const key = `${target.instanceID}:${target.territoryID}`;
    if (seen.has(key)) return jsonError("duplicate_instance", 400);
    seen.add(key);
  }

  const id = env.DATA_CENTER_STATE.idFromName(`dc:${body.dataCenterID}`);
  return env.DATA_CENTER_STATE.get(id).fetch("https://internal/internal/subscriptions", {
    method: "POST",
    body: JSON.stringify(body)
  });
}
