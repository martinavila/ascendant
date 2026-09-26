import type { GameState } from './types';
import { World } from './world';
import { visibilityTick } from './visibility';
import { SAVE_VERSION } from './gen';

export function serialize(w: World): string {
  w.syncRng();
  return JSON.stringify(w.s);
}

export function deserialize(json: string): World {
  const s = JSON.parse(json) as GameState;
  migrate(s);
  const w = new World(s);
  visibilityTick(w);
  return w;
}

function migrate(s: GameState) {
  if (!s.proposals) s.proposals = [];
  for (const e of s.empires) {
    e.logistics ??= 0;
    e.last ??= { ind: 0, res: 0, pro: 0, pop: 0, logisticsIn: 0 };
  }
  s.version = SAVE_VERSION;
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// --- IndexedDB slots -----------------------------------------------------------

const DB = 'ascendant-saves';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('saves');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface SaveMeta { slot: string; name: string; day: number; savedAt: number; species: string; stars: number }

export async function saveSlot(w: World, slot: string, name?: string) {
  const blob = await gzip(serialize(w));
  const human = w.human();
  const meta: SaveMeta = { slot, name: name ?? human?.name ?? 'Game', day: w.s.day, savedAt: Date.now(), species: human?.species ?? '', stars: w.s.stars.length };
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction('saves', 'readwrite');
    tx.objectStore('saves').put({ meta, blob }, slot);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function listSaves(): Promise<SaveMeta[]> {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const tx = d.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').getAll();
      req.onsuccess = () => res((req.result as { meta: SaveMeta }[]).map((r) => r.meta).sort((a, b) => b.savedAt - a.savedAt));
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

export async function loadSlot(slot: string): Promise<World | null> {
  const d = await db();
  const rec = await new Promise<{ blob: Blob } | undefined>((res, rej) => {
    const tx = d.transaction('saves', 'readonly');
    const req = tx.objectStore('saves').get(slot);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (!rec) return null;
  return deserialize(await gunzip(rec.blob));
}

export async function deleteSlot(slot: string) {
  const d = await db();
  await new Promise<void>((res) => {
    const tx = d.transaction('saves', 'readwrite');
    tx.objectStore('saves').delete(slot);
    tx.oncomplete = () => res();
  });
}

export async function exportFile(w: World): Promise<Blob> {
  return gzip(serialize(w));
}

export async function importFile(file: Blob): Promise<World> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const text = head[0] === 0x1f && head[1] === 0x8b ? await gunzip(file) : await file.text();
  return deserialize(text);
}
