import type { AgendaEvent } from "./agenda";

export const minuteOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** Interval partitioning: adjacent events may share a track; overlaps never do.
 * All-day events belong in the all-day tray. Overnight events end at this day's edge.
 */
export function orbitTracks(events: AgendaEvent[]) {
  const ends: number[] = [];
  return events.filter(e => !e.allDay).map(event => {
    const start = minuteOf(event.start);
    if (event.rawKind === "deadline") return { event, start: Math.max(0, start - 3), end: Math.min(1440, start + 3) };
    const end = minuteOf(event.end);
    return { event, start, end: end <= start ? 1440 : end };
  }).sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id))
    .map(item => {
      let lane = ends.findIndex(end => end <= item.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = item.end;
      return { ...item, lane };
    });
}
