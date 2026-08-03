import type { Env, NormalizedReport, ReportResponse } from "./models";
import { jsonError, validateReport } from "./validation";

const inFlightReports = new Map<string, Promise<Response>>();

export async function handleUpload(request: Request, env: Env): Promise<Response> {
  const receivedAt = Math.floor(Date.now() / 1000);
  const validation = await validateReport(request, env, receivedAt);
  if ("response" in validation) return validation.response;

  const requestID = crypto.randomUUID();
  const report = validation.report;
  const cacheKey = createCacheKey(report);
  const cachedResponse = await caches.default.match(cacheKey);
  if (cachedResponse)
    return createCachedResponse(cachedResponse, requestID, receivedAt);

  const reportKey = cacheKey.url;
  const activeRequest = inFlightReports.get(reportKey);
  if (activeRequest) {
    let sharedResponse: Response;
    try {
      sharedResponse = await activeRequest;
    } catch (error) {
      console.error(JSON.stringify({
        requestID,
        dataCenterID: report.dataCenterID,
        zoneServerID: report.zoneServerID,
        error: String(error)
      }));
      return jsonError("state_service_unavailable", 503);
    }
    const coalescedResponse = await caches.default.match(cacheKey);
    if (coalescedResponse)
      return createCachedResponse(coalescedResponse, requestID, receivedAt);
    return sharedResponse.clone();
  }

  const durableRequest = forwardReport(report, env, requestID, cacheKey);
  inFlightReports.set(reportKey, durableRequest);

  try {
    return (await durableRequest).clone();
  } catch (error) {
    console.error(JSON.stringify({
      requestID,
      dataCenterID: report.dataCenterID,
      zoneServerID: report.zoneServerID,
      error: String(error)
    }));
    return jsonError("state_service_unavailable", 503);
  } finally {
    if (inFlightReports.get(reportKey) === durableRequest)
      inFlightReports.delete(reportKey);
  }
}

async function forwardReport(
  report: NormalizedReport,
  env: Env,
  requestID: string,
  cacheKey: Request
): Promise<Response> {
  const id = env.DATA_CENTER_STATE.idFromName(`dc:${report.dataCenterID}`);
  const durableObject = env.DATA_CENTER_STATE.get(id);
  const response = await durableObject.fetch("https://internal/internal/reports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestID
    },
    body: JSON.stringify(report)
  });

  if (response.ok) {
    const cacheHeaders = new Headers(response.headers);
    cacheHeaders.set("cache-control", "public, max-age=90");
    try {
      await caches.default.put(cacheKey, new Response(response.clone().body, {
        status: response.status,
        headers: cacheHeaders
      }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "report_cache.put_failed", error: String(error) }));
    }
  }

  return response;
}

async function createCachedResponse(response: Response, requestID: string, receivedAt: number): Promise<Response> {
  const payload = await response.json<ReportResponse>();
  return Response.json({
    ...payload,
    requestID,
    serverTime: receivedAt
  } satisfies ReportResponse, {
    headers: {
      "cache-control": "no-store",
      "x-ce-report-cache": "hit"
    }
  });
}

function createCacheKey(report: NormalizedReport): Request {
  const events = report.events
    .map(event => `${event.eventType}-${event.eventID}-${event.spawnedAt}`)
    .sort()
    .join("_");
  return new Request(
    `https://report-cache.internal/${report.dataCenterID}/${report.zoneServerID}/${report.territoryID}/${events}`
  );
}
