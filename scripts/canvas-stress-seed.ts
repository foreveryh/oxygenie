/**
 * Canvas Agent (M4, impl spec §6.4) — seed N synthetic assets into a canvas workspace
 * for manual perf verification ("素材数向上 500 做手动压测"). Does NOT probe real image
 * dimensions or write real files — these are placeholder rows sized/positioned via the
 * same assignSlots()/fitInSlot() the real pipeline uses, purely to load-test xyflow
 * rendering (pan/zoom at 500 nodes, onlyRenderVisibleElements behavior).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/canvas-stress-seed.ts <canvasId> [count=500] [--cleanup]
 *
 * canvasAsset.id is a real Postgres `uuid` column, so synthetic rows use plain
 * randomUUID() ids (no id-prefix trick — that's not valid uuid syntax and Postgres
 * rejects it at insert time). The set of ids created for a given canvas is tracked in
 * a sidecar JSON file next to this script instead (canvasAsset.meta is a fixed-shape
 * type, not a place to bolt on an "is synthetic" flag for a one-off tool); --cleanup
 * reads that file to know exactly which rows to remove.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasAsset, canvasWorkspace } from '~/db/schema';
import { assignSlots, fitInSlot } from '~/server/canvas/slot-layout';

const idsFilePath = (canvasId: string) => join(import.meta.dirname, `.stress-ids-${canvasId}.json`);

async function main() {
  const [canvasId, countArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const cleanup = process.argv.includes('--cleanup');
  if (!canvasId) {
    console.error('Usage: npx tsx scripts/canvas-stress-seed.ts <canvasId> [count=500] [--cleanup]');
    process.exit(1);
  }

  const [workspace] = await db.select().from(canvasWorkspace).where(eq(canvasWorkspace.id, canvasId));
  if (!workspace) {
    console.error(`canvas workspace ${canvasId} not found`);
    process.exit(1);
  }

  if (cleanup) {
    const file = idsFilePath(canvasId);
    if (!existsSync(file)) {
      console.log(`no sidecar id file for ${canvasId} — nothing to clean up`);
      process.exit(0);
    }
    const ids: string[] = JSON.parse(readFileSync(file, 'utf8'));
    const deleted = await db
      .delete(canvasAsset)
      .where(inArray(canvasAsset.id, ids))
      .returning({ id: canvasAsset.id });
    unlinkSync(file);
    console.log(`removed ${deleted.length} synthetic assets from ${canvasId}`);
    process.exit(0);
  }

  const count = Number(countArg ?? 500);
  console.log(`seeding ${count} synthetic assets into canvas ${canvasId}...`);

  const existing = await db
    .select({ posX: canvasAsset.posX, posY: canvasAsset.posY })
    .from(canvasAsset)
    .where(eq(canvasAsset.canvasId, canvasId));

  const slots = assignSlots(count, existing);
  const size = fitInSlot(1024, 1024); // square placeholder, same dims a t2i image would use

  // Alternate image/video/text types so the stress test also exercises all three
  // node renderers together, not just one. relPath must be non-null (canvas-root.tsx's
  // asset filter drops any row with a falsy relPath, which would silently exclude
  // these from rendering entirely) — a fake filename is enough: the <img>/<video> tag
  // 404s on the asset route, which is fine for a pure layout/pan/zoom perf check; DOM
  // node count + xyflow bookkeeping cost is what's being measured, not decode cost of
  // 500 real images.
  const TYPES = ['image', 'video', 'text'] as const;
  const rows = slots.map((slot, i) => {
    const type = TYPES[i % TYPES.length];
    const id = randomUUID();
    return {
      id,
      canvasId,
      type,
      relPath: type === 'video' ? `${id}.mp4` : type === 'text' ? `notes/${id}.md` : `${id}.png`,
      meta: type === 'text' ? { text: { content: `Stress node ${i}`, align: 'left' as const, fontSize: 16 } } : {},
      posX: slot.posX,
      posY: slot.posY,
      width: size.width,
      height: size.height,
      status: 'ready' as const,
    };
  });

  // Batch insert (drizzle handles arrays natively; chunk to stay well under any
  // parameter-count limits on very large counts).
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(canvasAsset).values(rows.slice(i, i + CHUNK));
  }

  const file = idsFilePath(canvasId);
  const priorIds: string[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  writeFileSync(file, JSON.stringify([...priorIds, ...rows.map((r) => r.id)]));

  console.log(`done — ${count} assets seeded. Open the canvas and manually check pan/zoom smoothness.`);
  console.log(`cleanup with: npx tsx scripts/canvas-stress-seed.ts ${canvasId} --cleanup`);
  process.exit(0);
}

main().catch((err) => {
  console.error('canvas-stress-seed failed:', err);
  process.exit(1);
});
