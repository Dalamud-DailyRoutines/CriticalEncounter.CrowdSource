import type { DurableEventState, DurableInstanceTrackState, ReportEvent } from "./models";

export const CE_SPLIT_INTERVAL_SECONDS = 5 * 60;

function eventsConflict(
  left: Pick<DurableEventState, "eventType" | "eventID" | "lastSpawnedAt">,
  right: Pick<DurableEventState, "eventType" | "eventID" | "lastSpawnedAt">
): boolean {
  if (left.eventType !== "CE" || right.eventType !== "CE")
    return false;
  const difference = Math.abs(left.lastSpawnedAt - right.lastSpawnedAt);
  if (left.eventID !== right.eventID)
    return difference < CE_SPLIT_INTERVAL_SECONDS;
  return false;
}

export function hasTrackConflict(
  track: DurableInstanceTrackState,
  events: ReportEvent[],
  territoryID: number
): boolean {
  for (const event of events) {
    for (const existing of Object.values(track.eventLastSeen)) {
      if (existing.territoryID !== territoryID ||
          existing.firstReceivedAt < track.conflictDetectionStartedAt)
        continue;
      if (eventsConflict(existing, {
        eventType: event.eventType,
        eventID: event.eventID,
        lastSpawnedAt: event.spawnedAt
      }))
        return true;
    }
  }
  return false;
}

export function countTrackCEMatches(
  track: DurableInstanceTrackState,
  events: ReportEvent[],
  territoryID: number
): number {
  return events.filter(event => {
    if (event.eventType !== "CE")
      return false;
    const existing = track.eventLastSeen[`${territoryID}:CE:${event.eventID}`];
    return existing?.lastSpawnedAt === event.spawnedAt;
  }).length;
}

export function haveTrackConflict(
  left: DurableInstanceTrackState,
  right: DurableInstanceTrackState
): boolean {
  for (const leftEvent of Object.values(left.eventLastSeen)) {
    if (leftEvent.firstReceivedAt < left.conflictDetectionStartedAt)
      continue;
    for (const rightEvent of Object.values(right.eventLastSeen)) {
      if (rightEvent.firstReceivedAt < right.conflictDetectionStartedAt ||
          leftEvent.territoryID !== rightEvent.territoryID)
        continue;
      if (eventsConflict(leftEvent, rightEvent))
        return true;
    }
  }
  return false;
}
