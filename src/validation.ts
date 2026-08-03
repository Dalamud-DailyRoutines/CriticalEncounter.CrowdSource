import { getAreaForTerritory, getDataCenterForWorld, getServerGroupForDataCenter, hasEvent } from "./catalog";
import type { Env, EventType, NormalizedReport, ObservedState, ReportRequest } from "./models";

export const MAX_REPORT_BYTES = 4096;

interface ValidationFailure {
  response: Response;
}

interface ValidationSuccess {
  report: NormalizedReport;
}

export type ValidationResult = ValidationFailure | ValidationSuccess;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function invalid(message: string, status = 400): ValidationFailure {
  return { response: jsonResponse({ error: message }, status) };
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isEventType(value: unknown): value is EventType {
  return value === "CE" || value === "FATE";
}

function isObservedState(eventType: EventType, value: unknown): value is ObservedState {
  return eventType === "CE"
    ? value === "Register" || value === "Warmup" || value === "Battle"
    : value === "Preparing" || value === "Running";
}

async function readBody(request: Request): Promise<string | undefined> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    length += value.byteLength;
    if (length > MAX_REPORT_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function validateReport(request: Request, env: Env, receivedAt: number): Promise<ValidationResult> {
  if (request.method !== "POST") return invalid("method_not_allowed", 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return invalid("content_type_required");
  if (request.headers.get("x-api-key") !== env.UPLOAD_API_KEY)
    return invalid("unauthorized", 401);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REPORT_BYTES) return invalid("payload_too_large", 413);

  const text = await readBody(request);
  if (text === undefined) return invalid("payload_too_large", 413);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return invalid("invalid_json");
  }

  if (payload === null || typeof payload !== "object") return invalid("invalid_payload");
  const report = payload as Partial<ReportRequest>;

  if (report.schemaVersion !== 2) return invalid("unsupported_schema", 422);
  if (!isInteger(report.currentWorldID) || !isInteger(report.dataCenterID) ||
      !isInteger(report.territoryID) || !isInteger(report.zoneServerID) ||
      !isInteger(report.observedAt))
    return invalid("invalid_numeric_field");
  if (report.zoneServerID < 1 || report.zoneServerID > 4294967295) return invalid("invalid_zone_server");

  const expectedDataCenter = getDataCenterForWorld(report.currentWorldID);
  if (expectedDataCenter === undefined || expectedDataCenter !== report.dataCenterID)
    return invalid("world_data_center_mismatch");

  const area = getAreaForTerritory(report.territoryID);
  if (!area) return invalid("unsupported_territory");
  const serverGroup = getServerGroupForDataCenter(report.dataCenterID);
  if (!serverGroup || !area.serverGroups.includes(serverGroup))
    return invalid("unsupported_territory_for_server");
  if (report.observedAt < receivedAt - 1800 || report.observedAt > receivedAt + 120)
    return invalid("invalid_observed_at");
  if (typeof report.reporterEpochID !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(report.reporterEpochID))
    return invalid("invalid_reporter_epoch");
  if (typeof report.pluginVersion !== "string" || !/^[A-Za-z0-9.+-]{1,32}$/.test(report.pluginVersion))
    return invalid("invalid_plugin_version");
  if (!Array.isArray(report.events) || report.events.length < 1 || report.events.length > 8)
    return invalid("invalid_event_count");

  const events = report.events.map(event => {
    if (event === null || typeof event !== "object") return null;
    const candidate = event as Partial<{
      eventType: unknown;
      eventID: unknown;
      spawnedAt: unknown;
      observedState: unknown;
    }>;
    if (!isEventType(candidate.eventType) ||
        !isInteger(candidate.eventID) ||
        !isInteger(candidate.spawnedAt) ||
        !isObservedState(candidate.eventType, candidate.observedState))
      return null;
    if (!hasEvent(report.territoryID!, candidate.eventType, candidate.eventID)) return null;
    if (candidate.spawnedAt < receivedAt - 1800 || candidate.spawnedAt > receivedAt + 120)
      return null;
    return {
      eventType: candidate.eventType,
      eventID: candidate.eventID,
      spawnedAt: candidate.spawnedAt,
      observedState: candidate.observedState
    };
  });

  if (events.some(event => event === null)) return invalid("invalid_event");

  return {
    report: {
      schemaVersion: 2,
      currentWorldID: report.currentWorldID,
      dataCenterID: report.dataCenterID,
      territoryID: report.territoryID,
      zoneServerID: report.zoneServerID,
      observedAt: report.observedAt,
      reporterEpochID: report.reporterEpochID,
      pluginVersion: report.pluginVersion,
      events: events as ReportRequest["events"],
      receivedAt
    }
  };
}

export function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
