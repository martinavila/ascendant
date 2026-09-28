import type { JSX } from 'preact';
import { BUILDING, PART } from '../sim/content';
import { classicBuilding, classicPart, classicPlanet } from '../art/classic';
import { portraitUrl } from '../art/portraits';
import { planetUrl, shipUrl } from '../art/procedural';
import { store } from './store';
import { SPECIES_BY_ID } from '../sim/content';
import type { Planet } from '../sim/types';

type P = { size?: number; class?: string; style?: JSX.CSSProperties };

const svg = (paths: JSX.Element, { size = 16, ...rest }: P, vb = '0 0 24 24') => (
  <svg width={size} height={size} viewBox={vb} fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" {...rest}>{paths}</svg>
);

export const Icon = {
  ind: (p: P = {}) => svg(<><path d="M3 21V10l5 3V10l5 3V6l8 4v11z" /><path d="M7 17h2M12 17h2M17 17h1" /></>, { class: 'ind', ...p }),
  res: (p: P = {}) => svg(<><path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /><path d="M7 15h10" /></>, { class: 'res', ...p }),
  pro: (p: P = {}) => svg(<><path d="M5 20c9 0 14-6 14-16C11 4 5 8 5 15v5z" /><path d="M5 20c2-5 5-8 9-10" /></>, { class: 'pro', ...p }),
  pop: (p: P = {}) => svg(<><circle cx="12" cy="7" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></>, { class: 'pop', ...p }),
  ship: (p: P = {}) => svg(<><path d="M3 12l7-7 11 7-11 7z" /><path d="M10 5v14" /></>, p),
  planet: (p: P = {}) => svg(<><circle cx="12" cy="12" r="6" /><path d="M3 15c3 2 15-2 18-7" /></>, p),
  star: (p: P = {}) => svg(<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />, p),
  play: (p: P = {}) => svg(<path d="M7 4l13 8-13 8z" fill="currentColor" />, p),
  pause: (p: P = {}) => svg(<><path d="M8 4v16M16 4v16" /></>, p),
  ff: (p: P = {}) => svg(<><path d="M3 5l9 7-9 7zM12 5l9 7-9 7z" fill="currentColor" /></>, p),
  skip: (p: P = {}) => svg(<><path d="M4 5l10 7-10 7z" fill="currentColor" /><path d="M19 5v14" /></>, p),
  step: (p: P = {}) => svg(<><path d="M6 5l8 7-8 7z" fill="currentColor" /></>, p),
  gear: (p: P = {}) => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, p),
  close: (p: P = {}) => svg(<path d="M6 6l12 12M18 6L6 18" />, p),
  menu: (p: P = {}) => svg(<path d="M4 7h16M4 12h16M4 17h16" />, p),
  up: (p: P = {}) => svg(<path d="M6 15l6-6 6 6" />, p),
  down: (p: P = {}) => svg(<path d="M6 9l6 6 6-6" />, p),
  trash: (p: P = {}) => svg(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>, p),
  target: (p: P = {}) => svg(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>, p),
  shield: (p: P = {}) => svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />, p),
  sword: (p: P = {}) => svg(<><path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2" /></>, p),
  book: (p: P = {}) => svg(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>, p),
  chart: (p: P = {}) => svg(<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>, p),
  handshake: (p: P = {}) => svg(<><path d="M11 17l2 2a1.4 1.4 0 0 0 2-2M14 14l2.5 2.5a1.4 1.4 0 0 0 2-2l-3.9-3.9a2 2 0 0 0-2.8 0l-.9.9a1.4 1.4 0 0 1-2-2L11.7 6a3 3 0 0 1 3.5-.5l.6.3a3 3 0 0 0 2 .3L21 5v8M3 5l4 .7L3 13v1l6 6 1.5-1.5" /></>, p),
  flask: (p: P = {}) => Icon.res(p),
  wrench: (p: P = {}) => svg(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />, p),
  save: (p: P = {}) => svg(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></>, p),
  help: (p: P = {}) => svg(<><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></>, p),
  eye: (p: P = {}) => svg(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>, p),
  bolt: (p: P = {}) => svg(<path d="M13 2L3 14h9l-1 8 10-12h-9z" />, p),
  trophy: (p: P = {}) => svg(<><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>, p),
  crosshair: (p: P = {}) => Icon.target(p),
  plus: (p: P = {}) => svg(<path d="M12 5v14M5 12h14" />, p),
  more: (p: P = {}) => svg(<><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></>, p),
  fit: (p: P = {}) => svg(<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />, p),
  list: (p: P = {}) => svg(<><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.2" fill="currentColor" /><circle cx="4.5" cy="12" r="1.2" fill="currentColor" /><circle cx="4.5" cy="18" r="1.2" fill="currentColor" /></>, p),
  route: (p: P = {}) => svg(<><circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /></>, p),
};

const ROLE_COLOR: Record<string, string> = {
  industry: '#ff9f43', research: '#5ab0ff', prosperity: '#6fe08a', housing: '#e8e8ff', mixed: '#c8a8ff', defense: '#ff6b6b', special: '#ffcf6a', shipyard: '#7fdcff',
};

/** Procedural building glyph (used when classic art isn't imported). */
function buildingGlyph(id: string, size: number) {
  const def = BUILDING[id];
  const col = ROLE_COLOR[def?.role ?? 'special'];
  const shapes: Record<string, JSX.Element> = {
    industry: <><path d="M6 34V20l8 5v-5l8 5v-9l12 6v12z" fill={col} fill-opacity=".35" /><path d="M10 14v-6h3v8" /></>,
    research: <><circle cx="20" cy="20" r="11" fill={col} fill-opacity=".3" /><ellipse cx="20" cy="20" rx="15" ry="5" /><circle cx="20" cy="20" r="3" fill={col} /></>,
    prosperity: <><path d="M8 34c14 0 22-9 22-26C18 8 8 14 8 26v8z" fill={col} fill-opacity=".35" /><path d="M8 34c3-8 8-13 15-17" /></>,
    housing: <><path d="M6 34V18L20 8l14 10v16z" fill={col} fill-opacity=".25" /><path d="M16 34v-9h8v9" /></>,
    mixed: <><rect x="7" y="12" width="8" height="22" fill={col} fill-opacity=".3" /><rect x="17" y="6" width="8" height="28" fill={col} fill-opacity=".3" /><rect x="27" y="16" width="6" height="18" fill={col} fill-opacity=".3" /></>,
    defense: <><path d="M20 5l12 5v9c0 8-5 13-12 15-7-2-12-7-12-15v-9z" fill={col} fill-opacity=".3" /><path d="M20 12v14M14 19h12" /></>,
    special: <><path d="M20 5l4 9 10 1-7.5 7 2 10L20 27l-8.5 5 2-10L6 15l10-1z" fill={col} fill-opacity=".3" /></>,
    shipyard: <><path d="M6 24l9-9 19 9-19 9z" fill={col} fill-opacity=".3" /><path d="M4 12h8M4 36h8M4 12v24" /></>,
  };
  return (
    <svg class="bicon" width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={col} stroke-width="2" stroke-linejoin="round">
      {def?.orbital && <ellipse cx="20" cy="20" rx="18" ry="7" stroke-opacity=".35" stroke-dasharray="3 3" />}
      {shapes[def?.role ?? 'special']}
    </svg>
  );
}

export function BuildingIcon({ id, size = 40 }: { id: string; size?: number }) {
  const url = store.settings.classicArt ? classicBuilding(id) : null;
  if (url) return <img src={url} width={size} height={size} alt={BUILDING[id]?.name ?? id} draggable={false} />;
  return buildingGlyph(id, size);
}

const PART_COLOR: Record<string, string> = { weapon: '#ff6b6b', shield: '#7fdcff', drive: '#ffcf6a', generator: '#6fe08a', scanner: '#b48cff', special: '#e8e8ff' };

export function PartIcon({ id, size = 36 }: { id: string; size?: number }) {
  if (!id) return <svg width={size} height={size} viewBox="0 0 40 40"><rect x="6" y="6" width="28" height="28" rx="6" fill="none" stroke="#5d6a91" stroke-dasharray="4 4" /></svg>;
  const url = store.settings.classicArt ? classicPart(id) : null;
  if (url) return <img src={url} width={size} height={size} style={{ objectFit: 'contain' }} alt={PART[id]?.name} draggable={false} />;
  const p = PART[id];
  const col = PART_COLOR[p?.category ?? 'special'];
  const g: Record<string, JSX.Element> = {
    weapon: <><path d="M6 26h18l6-6-6-6H6z" fill={col} fill-opacity=".3" /><path d="M30 20h6" /></>,
    shield: <path d="M20 5l12 5v9c0 8-5 13-12 15-7-2-12-7-12-15v-9z" fill={col} fill-opacity=".3" />,
    drive: <><path d="M8 14h16l8 6-8 6H8z" fill={col} fill-opacity=".3" /><path d="M4 16l4 4-4 4" /></>,
    generator: <><circle cx="20" cy="20" r="12" fill={col} fill-opacity=".25" /><path d="M21 11l-6 10h6l-2 8 7-11h-6z" /></>,
    scanner: <><path d="M8 28a16 16 0 0 1 24 0" /><path d="M13 24a9 9 0 0 1 14 0" /><circle cx="20" cy="28" r="3" fill={col} /></>,
    special: <><rect x="9" y="9" width="22" height="22" rx="5" fill={col} fill-opacity=".25" /><circle cx="20" cy="20" r="4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={col} stroke-width="2" stroke-linejoin="round">{g[p?.category ?? 'special']}</svg>;
}

export function planetImage(p: Pick<Planet, 'type' | 'id'>, size = 96): string {
  const c = store.settings.classicArt ? classicPlanet(p.type) : null;
  return c ?? planetUrl(p.type, p.id * 7919 + 13, size);
}

export function PlanetOrb({ planet, size = 48 }: { planet: Pick<Planet, 'type' | 'id' | 'size'>; size?: number }) {
  return <img class="planet-orb" src={planetImage(planet, size > 90 ? 256 : 96)} width={size} height={size} alt="" draggable={false} style={{ objectFit: 'contain' }} />;
}

/** Original, procedurally painted portrait for every species (3:2). */
export function portrait(speciesId: string, color: string, big = false): string {
  const sp = SPECIES_BY_ID[speciesId];
  return portraitUrl(speciesId, sp?.color ?? color, big ? 480 : 240);
}

export function Portrait({ species, color, size = 40, big = false }: { species: string; color: string; size?: number; big?: boolean }) {
  return <img src={portrait(species, color, big)} width={size} height={size} style={{ objectFit: 'cover', borderRadius: 8, border: `2px solid ${color}` }} alt="" draggable={false} />;
}

export function ShipImage({ species, hull, color, size = 40 }: { species: string; hull: string; color: string; size?: number }) {
  const sp = SPECIES_BY_ID[species];
  return <img src={shipUrl(hull, color, sp?.style ?? 0, 64)} width={size} height={size} style={{ objectFit: 'contain' }} alt="" draggable={false} />;
}

export function EmpireDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span class="dot" style={{ background: color, width: size, height: size, boxShadow: `0 0 8px ${color}` }} />;
}
