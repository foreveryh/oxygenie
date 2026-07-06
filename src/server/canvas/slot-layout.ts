/**
 * Canvas slot layout (PRD F3.2 — fixed square slots, row-flow, 4 per row).
 *
 * Pure functions, no DB access — callers pass in the positions already occupied so
 * concurrent generations don't collide (the caller does this inside a query, see
 * src/routes/api/internal/canvas/tasks.ts).
 */

export const SLOT = 280;
export const GAP = 24;
export const COLS = 4;
export const PITCH = SLOT + GAP;

export type Pos = { posX: number; posY: number };

export function slotOf(a: Pos): number {
  return Math.round(a.posY / PITCH) * COLS + Math.round(a.posX / PITCH);
}

export function originOf(i: number): { posX: number; posY: number } {
  return { posX: (i % COLS) * PITCH, posY: Math.floor(i / COLS) * PITCH };
}

/**
 * Find the next N free slots. If `sourcePositions` is given (derived asset — e.g. a
 * re-generation referencing an existing image), search starts right after the
 * rightmost referenced slot (PRD F3.2: derived nodes land beside their source) instead
 * of at the global row-flow front.
 */
export function assignSlots(count: number, existing: Pos[], sourcePositions?: Pos[]): Array<{ posX: number; posY: number }> {
  const used = new Set(existing.map(slotOf));
  const start = sourcePositions?.length ? Math.max(...sourcePositions.map(slotOf)) + 1 : 0;
  const slots: Array<{ posX: number; posY: number }> = [];
  let i = start;
  while (slots.length < count) {
    if (!used.has(i)) {
      used.add(i);
      slots.push(originOf(i));
    }
    i++;
  }
  return slots;
}

/** Fit a w×h asset inside the SLOT×SLOT square, preserving aspect ratio (contain). */
export function fitInSlot(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(SLOT / width, SLOT / height);
  return { width: width * scale, height: height * scale };
}
