import type { DurableInstanceTrackState, ReportEvent } from "./models";

export const CE_SPLIT_INTERVAL_SECONDS = 5 * 60;
export const TOWER_REPEAT_INTERVAL_SECONDS = 3_600;
export const TOWER_CE_IDS = new Set([48, 64]);

export function hasTrackConflict(
  track: DurableInstanceTrackState,
  events: ReportEvent[],
  territoryID: number
): boolean {
  for (const event of events) {
    for (const existing of Object.values(track.eventLastSeen)) {
      if (existing.territoryID !== territoryID)
        continue;
      const difference = Math.abs(existing.lastSpawnedAt - event.spawnedAt);
      if (event.eventType === "CE" && existing.eventType === "CE" &&
          existing.eventID !== event.eventID && difference < CE_SPLIT_INTERVAL_SECONDS)
        return true;
      if (event.eventType === "CE" && existing.eventType === "CE" &&
          event.eventID === existing.eventID && TOWER_CE_IDS.has(event.eventID) &&
          difference > 0 && difference < TOWER_REPEAT_INTERVAL_SECONDS)
        return true;
    }
  }
  return false;
}
