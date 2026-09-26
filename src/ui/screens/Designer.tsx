import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { store, useStore, dispatch } from '../store';
import { Modal, Bar, act, fmt } from '../common';
import { Icon, PartIcon, ShipImage } from '../icons';
import { HULLS, HULL, PART, PARTS, TECH, SPECIES_BY_ID } from '../../sim/content';
import { suggestDesign, inferRole } from '../../sim/commands';
import { bestParts, type DesignRole } from '../../sim/ai/designer';
import type { Empire, PartDef, ShipDesign } from '../../sim/types';
import type { ShipStats, World } from '../../sim/world';

// ---------------------------------------------------------------------------
// Ship Designer: design list (left), hull + slots + stats (center), part picker
// (right). Click a slot, click a part: it fills and jumps to the next empty slot.
// ---------------------------------------------------------------------------

type Category = PartDef['category'];

interface Draft {
  /** Saved design being edited; undefined for a brand-new draft. */
  id?: number;
  name: string;
  hull: string;
  parts: string[];
  /** The player typed a name; auto-design won't overwrite it. */
  nameDirty: boolean;
}

interface DesignerArg { design?: number; refitFleet?: number }

const CATEGORIES: { id: Category; label: string; key: string }[] = [
  { id: 'weapon', label: 'Weapons', key: '1' },
  { id: 'shield', label: 'Shields', key: '2' },
  { id: 'drive', label: 'Drives', key: '3' },
  { id: 'generator', label: 'Power', key: '4' },
  { id: 'scanner', label: 'Sensors', key: '5' },
  { id: 'special', label: 'Special', key: '6' },
];

const CAT_COLOR: Record<Category, string> = { weapon: '#ff6b6b', shield: '#7fdcff', drive: '#ffcf6a', generator: '#6fe08a', scanner: '#b48cff', special: '#e8e8ff' };

const ROLE_ORDER: DesignRole[] = ['warship', 'invader', 'colony', 'outpost', 'scout', 'support'];
const ROLE_LABEL: Record<DesignRole, string> = { warship: 'Warship', invader: 'Invader', colony: 'Colony Ship', outpost: 'Outpost Ship', scout: 'Scout', support: 'Support' };
const ROLE_GROUP: Record<DesignRole, string> = { warship: 'Warships', invader: 'Invasion', colony: 'Colony Ships', outpost: 'Outpost Ships', scout: 'Scouts', support: 'Support' };
const ROLE_COLOR: Record<DesignRole, string> = { warship: '#ff6b6b', invader: '#ff9f43', colony: '#6fe08a', outpost: '#9fe0c8', scout: '#b48cff', support: '#7fdcff' };
const AUTO_ROLES: { role: DesignRole; label: string; needs?: string; tip: string }[] = [
  { role: 'warship', label: 'Warship', tip: 'Best weapons, shields and armor your tech allows, with enough drives and power.' },
  { role: 'colony', label: 'Colony', needs: 'colony', tip: 'A colony module plus drives — founds new colonies.' },
  { role: 'outpost', label: 'Outpost', needs: 'outpost', tip: 'An outpost kit plus drives — claims marginal worlds.' },
  { role: 'invader', label: 'Invader', needs: 'invasion', tip: 'Invasion modules with protection — seizes enemy planets.' },
  { role: 'scout', label: 'Scout', tip: 'Fast, long-sighted, cloaked if possible.' },
];

const LANE = 150;
const daysPerLane = (speed: number) => (speed > 0 ? Math.ceil(LANE / (16 * speed)) : Infinity);

/** One-line headline stat for a part, as shown in the picker and slot list. */
function keyStat(p: PartDef, luminous: boolean): { main: string; sub?: string } {
  switch (p.category) {
    case 'weapon': return { main: `${p.damage}×${p.shots}`, sub: `rng ${p.range}` };
    case 'shield': return { main: `${p.strength}`, sub: 'absorb/rd' };
    case 'drive': return { main: `+${p.speed}`, sub: 'thrust' };
    case 'generator': return { main: `+${p.power + (luminous ? 1 : 0)}`, sub: 'power' };
    case 'scanner': return { main: `${p.scan}`, sub: 'scan' };
    case 'special':
      if (p.special === 'armor') return { main: `+${p.hp}`, sub: 'hull' };
      return { main: specialLabel(p.special ?? ''), sub: p.consumable ? 'consumed' : undefined };
  }
}

function specialLabel(k: string) {
  return ({ colony: 'Colonize', outpost: 'Outpost', invasion: 'Troops', armor: 'Armor', repair: 'Repair', cloak: 'Cloak', laneDrive: 'Red lanes', tractor: 'Grapple', jammer: 'Jammer' } as Record<string, string>)[k] ?? k;
}

function partTip(p: PartDef, luminous: boolean, isNew: boolean) {
  const lines = [`${p.name}${isNew ? '  (new)' : ''}`, p.desc];
  switch (p.category) {
    case 'weapon': lines.push(`Damage ${p.damage} × ${p.shots} shot${p.shots! > 1 ? 's' : ''} per round · range ${p.range}`); break;
    case 'shield': lines.push(`Absorbs ${p.strength} damage per round (regenerates)`); break;
    case 'drive': lines.push(`+${p.speed} thrust (ship speed = thrust ÷ hull mass)`); break;
    case 'generator': lines.push(`Supplies ${p.power + (luminous ? 1 : 0)} power${luminous ? ' (incl. +1 Luminous trait)' : ''}`); break;
    case 'scanner': lines.push(`Sensor range ${p.scan}`); break;
    case 'special': if (p.hp) lines.push(`+${p.hp} hull points`); break;
  }
  if (p.category !== 'generator') lines.push(p.power ? `Draws ${p.power} power` : 'Needs no power');
  lines.push(`Cost ${p.cost}`);
  if (p.tech && TECH[p.tech]) lines.push(`From: ${TECH[p.tech].name}`);
  return lines.join('\n');
}

function sameParts(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] || '') !== (b[i] || '')) return false;
  return true;
}

function fitParts(parts: string[], slots: number) {
  const out = parts.slice(0, slots);
  while (out.length < slots) out.push('');
  return out;
}

function defaultHull(w: World, e: number) {
  const known = HULLS.filter((h) => w.knows(e, h.tech));
  return (known.find((h) => h.id === 'medium') ?? known[0] ?? HULLS[0]).id;
}

function draftFrom(d: ShipDesign): Draft {
  return { id: d.id, name: d.name, hull: d.hull, parts: fitParts(d.parts, HULL[d.hull].slots), nameDirty: true };
}

function blankDraft(w: World, e: number, hull?: string): Draft {
  const h = hull ?? defaultHull(w, e);
  return { name: 'New Design', hull: h, parts: fitParts([], HULL[h].slots), nameDirty: false };
}

function autoName(w: World, e: number, role: DesignRole) {
  const n = Object.values(w.s.designs).filter((d) => d.owner === e && d.role === role).length + 1;
  return `${ROLE_LABEL[role]} Mk ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] ?? n}`;
}

function powerDemand(parts: string[]) {
  let d = 0;
  for (const id of parts) if (id && PART[id].category !== 'generator') d += PART[id].power;
  return d;
}

// ---------------------------------------------------------------------------

export function DesignerScreen() {
  const st = useStore();
  const w = st.world;
  const human = w?.human();
  if (!w || !human) return <Modal title="Ship Designer"><div class="dim" style={{ padding: 24 }}>No game in progress.</div></Modal>;
  return <Designer w={w} human={human} arg={(st.screenArg ?? {}) as DesignerArg} />;
}

function Designer({ w, human, arg }: { w: World; human: Empire; arg: DesignerArg }) {
  const e = human.id;
  const sp = SPECIES_BY_ID[human.species];
  const luminous = sp.trait === 'luminous';

  const initial = (): Draft => {
    const d = arg.design != null ? w.s.designs[arg.design] : undefined;
    if (d && d.owner === e) return draftFrom(d);
    // Refit with no design given: start from the fleet's most common design.
    if (arg.refitFleet != null) {
      const f = w.s.fleets[arg.refitFleet];
      const first = f?.ships.map((id) => w.s.ships[id]).find(Boolean);
      const fd = first ? w.s.designs[first.design] : undefined;
      if (fd && fd.owner === e) return draftFrom(fd);
      if (first) return { ...blankDraft(w, e, first.hull), parts: fitParts(first.parts, HULL[first.hull].slots), name: `${f!.name} Refit`, nameDirty: true };
    }
    return blankDraft(w, e);
  };

  const [draft, setDraft] = useState<Draft>(initial);
  const [sel, setSel] = useState<number | null>(() => {
    const i = initial().parts.findIndex((x) => !x);
    return i >= 0 ? i : null;
  });
  const [cat, setCat] = useState<Category>('weapon');
  const [sortBy, setSortBy] = useState<'best' | 'new' | 'cost'>('best');
  const [compareId, setCompareId] = useState<number | null>(null);
  const [showObsolete, setShowObsolete] = useState(false);

  // Re-open with a different argument (e.g. "Edit design" from the HUD while open).
  useEffect(() => {
    const d = initial();
    setDraft(d);
    const i = d.parts.findIndex((x) => !x);
    setSel(i >= 0 ? i : null);
  }, [arg.design, arg.refitFleet]);

  const hull = HULL[draft.hull];
  const stats = w.shipStats(e, draft.hull, draft.parts);
  const role = inferRole(w, e, draft.hull, draft.parts);
  const saved = draft.id != null ? w.s.designs[draft.id] : undefined;
  const dirty = !saved || saved.name !== draft.name || saved.hull !== draft.hull || !sameParts(saved.parts, draft.parts);

  // --- tech recency -------------------------------------------------------
  const known = human.research.known;
  const recency = useMemo(() => new Map(known.map((t, i) => [t, i] as const)), [known.length]);
  const rec = (tech?: string) => (tech ? recency.get(tech) ?? -1 : -1);
  const isNew = (tech?: string) => !!tech && rec(tech) >= Math.max(0, known.length - 3);

  // --- mutations ----------------------------------------------------------
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setParts = (parts: string[]) => update({ parts });

  const nextEmpty = (parts: string[], from: number) => {
    for (let k = 1; k <= parts.length; k++) {
      const j = (from + k) % parts.length;
      if (!parts[j]) return j;
    }
    return null;
  };

  const place = (partId: string, fillAll: boolean) => {
    const parts = [...draft.parts];
    if (fillAll) {
      let n = 0;
      for (let i = 0; i < parts.length; i++) if (!parts[i]) { parts[i] = partId; n++; }
      if (!n) { store.notify('No empty slots to fill.', 'error'); return; }
      setParts(parts);
      setSel(null);
      return;
    }
    const i = sel ?? parts.findIndex((x) => !x);
    if (i < 0 || i == null) { store.notify('All slots are full — select a slot to replace its part.', 'error'); return; }
    parts[i] = partId;
    setParts(parts);
    setSel(nextEmpty(parts, i));
  };

  const clearSlot = (i: number) => {
    const parts = [...draft.parts];
    parts[i] = '';
    setParts(parts);
    setSel(i);
  };

  const moveSlot = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.parts.length) return;
    const parts = [...draft.parts];
    [parts[i], parts[j]] = [parts[j], parts[i]];
    setParts(parts);
    setSel(j);
  };

  const changeHull = (id: string) => {
    if (id === draft.hull) return;
    const slots = HULL[id].slots;
    const lost = draft.parts.slice(slots).filter(Boolean).length;
    const parts = fitParts(draft.parts, slots);
    update({ hull: id, parts });
    const i = parts.findIndex((x) => !x);
    setSel(i >= 0 ? i : null);
    if (lost) store.notify(`${lost} part${lost > 1 ? 's' : ''} didn't fit the smaller hull and were removed.`);
  };

  const autoDesign = (r: DesignRole) => {
    const s = suggestDesign(w, e, r, draft.hull);
    setDraft((d) => ({ ...d, hull: s.hull, parts: fitParts(s.parts, HULL[s.hull].slots), name: d.nameDirty ? d.name : autoName(w, e, r) }));
    const i = s.parts.findIndex((x) => !x);
    setSel(i >= 0 ? i : null);
  };

  const openDesign = (d: ShipDesign) => {
    const nd = draftFrom(d);
    setDraft(nd);
    const i = nd.parts.findIndex((x) => !x);
    setSel(i >= 0 ? i : null);
    if (compareId === d.id) setCompareId(null);
  };

  const newDesign = () => {
    setDraft(blankDraft(w, e, draft.hull));
    setSel(0);
  };

  const duplicate = () => {
    setDraft((d) => ({ ...d, id: undefined, name: `${d.name} (copy)`, nameDirty: true }));
    if (saved) setCompareId(saved.id);
  };

  /** Save the draft (optionally queueing refits for a fleet in the same command). */
  const save = (asNew: boolean, refitFleet?: number): boolean => {
    const name = draft.name.trim() || autoName(w, e, role);
    if (!draft.parts.some(Boolean)) { store.notify('Add at least one part before saving.', 'error'); return false; }
    const fresh = asNew || draft.id == null;
    dispatch({ t: 'saveDesign', design: { id: asNew ? undefined : draft.id, name, hull: draft.hull, parts: draft.parts }, refitFleet }, (r) => {
      if (typeof r.value === 'number') setDraft((x) => ({ ...x, id: r.value as number, name, nameDirty: true }));
      if (refitFleet === undefined) act(r.ok ? null : r, r.ok ? (fresh ? `Design “${name}” saved.` : `Design “${name}” updated.`) : undefined);
      else act(r, r.ok ? `Design “${name}” saved; refits queued at the shipyard.` : undefined);
    });
    return true;
  };

  const toggleObsolete = () => {
    if (!saved) return;
    const was = saved.obsolete;
    act(dispatch({ t: 'obsolete', design: saved.id, obsolete: !was }), !was ? `${saved.name} marked obsolete.` : `${saved.name} restored.`);
  };

  // --- refit --------------------------------------------------------------
  const fleet = arg.refitFleet != null ? w.s.fleets[arg.refitFleet] : undefined;
  const fleetInfo = useMemo(() => {
    if (!fleet || fleet.owner !== e) return null;
    const ships = fleet.ships.map((id) => w.s.ships[id]).filter(Boolean);
    const atYard = w.planetsOf[e].some((pid) => {
      const p = w.s.planets[pid];
      return p.star === fleet.star && w.econ(p).hasShipyard;
    });
    return { ships: ships.length, matching: ships.filter((s) => s.hull === draft.hull).length, atYard };
  }, [fleet, draft.hull, w.version]);

  const refit = () => {
    if (!fleet) return;
    if (dirty || !saved) { save(false, fleet.id); return; }
    act(dispatch({ t: 'refitFleet', fleet: fleet.id, design: saved.id }), `Refits for ${fleet.name} queued at the shipyard.`);
  };

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const n = draft.parts.length;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel != null) { ev.preventDefault(); clearSlot(sel); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel((s) => (s == null ? 0 : Math.min(n - 1, s + 1))); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel((s) => (s == null ? n - 1 : Math.max(0, s - 1))); }
      else {
        const c = CATEGORIES.find((x) => x.key === ev.key);
        if (c) setCat(c.id);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [draft, sel]);

  // --- data for panels ----------------------------------------------------
  const myDesigns = Object.values(w.s.designs).filter((d) => d.owner === e);
  const shipCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of Object.values(w.s.ships)) if (s.owner === e) m.set(s.design, (m.get(s.design) ?? 0) + 1);
    return m;
  }, [w.version, Object.keys(w.s.ships).length]);

  const compareDesign = compareId != null ? w.s.designs[compareId] : saved && dirty ? saved : undefined;
  const compareLabel = compareId != null ? compareDesign?.name : compareDesign ? 'Saved version' : undefined;
  const compareStats = compareDesign ? w.shipStats(e, compareDesign.hull, compareDesign.parts) : undefined;

  const sortedParts = useMemo(() => {
    const bp = bestParts(w, e);
    const rank = new Map<string, number>();
    const lists: PartDef[][] = [bp.weapons, bp.shields, bp.drives, bp.generators, bp.scanners];
    for (const l of lists) l.forEach((p, i) => rank.set(p.id, i));
    const knownParts = PARTS.filter((p) => w.knows(e, p.tech));
    const out: Record<Category, PartDef[]> = { weapon: [], shield: [], drive: [], generator: [], scanner: [], special: [] };
    for (const p of knownParts) out[p.category].push(p);
    for (const c of Object.keys(out) as Category[]) {
      out[c].sort((a, b) => {
        if (sortBy === 'cost') return a.cost - b.cost;
        if (sortBy === 'new') return rec(b.tech) - rec(a.tech) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
        if (c === 'special') {
          // Specials aren't comparable: modules first, then newest tech.
          const mod = (p: PartDef) => (p.consumable ? 1 : 0);
          return mod(b) - mod(a) || rec(b.tech) - rec(a.tech);
        }
        return (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99) || rec(b.tech) - rec(a.tech);
      });
    }
    return out;
  }, [w.version, known.length, sortBy]);

  const knownHulls = HULLS.filter((h) => w.knows(e, h.tech));
  const selPart = sel != null ? draft.parts[sel] : '';

  const classicImg: string | null = null;

  return (
    <Modal
      title={<span class="row" style={{ gap: 10 }}><Icon.wrench size={18} />Ship Designer</span>}
      width="min(1320px, 100%)"
      height="min(880px, 100%)"
    >
      <style>{CSS}</style>
      <div class="sd-root">
        {/* ---------------- left: design list ---------------- */}
        <aside class="sd-list">
          <div class="sd-list-head">
            <span class="caps">Your designs</span>
            <div class="spacer" />
            <span class="dim tiny">{myDesigns.filter((d) => !d.obsolete).length} active</span>
          </div>
          <div class="sd-list-actions">
            <button class="btn sm" onClick={newDesign} data-tip="Start a blank design on the current hull"><Icon.plus size={13} />New</button>
            <button class="btn sm" onClick={duplicate} disabled={!saved} data-tip="Copy this design into a new, unsaved draft">Duplicate</button>
            <button class="btn sm" onClick={toggleObsolete} disabled={!saved} data-tip={saved?.obsolete ? 'Restore to the active build lists' : 'Hide from build lists (existing ships are unaffected)'}>
              {saved?.obsolete ? 'Restore' : 'Obsolete'}
            </button>
          </div>
          <div class="sd-list-body scroll">
            {ROLE_ORDER.map((r) => {
              const ds = myDesigns.filter((d) => !d.obsolete && (d.role ?? 'warship') === r).sort((a, b) => b.created - a.created);
              if (!ds.length) return null;
              return (
                <div class="sd-group" key={r}>
                  <div class="sd-group-title"><span class="sd-role-dot" style={{ background: ROLE_COLOR[r] }} />{ROLE_GROUP[r]}<span class="faint">{ds.length}</span></div>
                  {ds.map((d) => <DesignRow key={d.id} d={d} human={human} count={shipCount.get(d.id) ?? 0} on={draft.id === d.id} onOpen={() => openDesign(d)} onCompare={() => setCompareId(compareId === d.id ? null : d.id)} comparing={compareId === d.id} />)}
                </div>
              );
            })}
            {myDesigns.length === 0 && <div class="dim small" style={{ padding: 12 }}>No designs yet. Pick a hull and use Auto-design to get started.</div>}
            {myDesigns.some((d) => d.obsolete) && (
              <div class="sd-group obsolete">
                <button class="sd-group-title sd-toggle" onClick={() => setShowObsolete(!showObsolete)}>
                  {showObsolete ? <Icon.down size={12} /> : <Icon.up size={12} style={{ transform: 'rotate(90deg)' }} />}
                  Obsolete<span class="faint">{myDesigns.filter((d) => d.obsolete).length}</span>
                </button>
                {showObsolete && myDesigns.filter((d) => d.obsolete).sort((a, b) => b.created - a.created).map((d) => (
                  <DesignRow key={d.id} d={d} human={human} count={shipCount.get(d.id) ?? 0} on={draft.id === d.id} onOpen={() => openDesign(d)} onCompare={() => setCompareId(compareId === d.id ? null : d.id)} comparing={compareId === d.id} />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ---------------- center: hull, ship, slots, stats ---------------- */}
        <main class="sd-main scroll">
          {fleet && fleetInfo && (
            <div class={'sd-refit' + (fleetInfo.atYard ? '' : ' away')}>
              <Icon.wrench size={18} />
              <div class="grow">
                <div><b>Refit fleet {fleet.name}</b> <span class="dim small">· {fleetInfo.ships} ship{fleetInfo.ships === 1 ? '' : 's'}, {fleetInfo.matching} on a {hull.name.toLowerCase()}</span></div>
                <div class="tiny dim">
                  {fleetInfo.atYard
                    ? fleetInfo.matching < fleetInfo.ships ? 'Only ships with a matching hull are refitted. Each changed slot is queued at the shipyard.' : 'Each changed slot is queued as a refit job at the shipyard.'
                    : 'The fleet must be parked at one of your shipyards to refit.'}
                </div>
              </div>
              <button class="btn primary sm" onClick={refit} disabled={!fleetInfo.matching} data-tip={dirty ? 'Saves this design, then queues the refits' : 'Queue per-slot refits at the shipyard'}>
                {dirty ? 'Save & refit fleet' : `Refit ${fleet.name} to this design`}
              </button>
            </div>
          )}

          {/* Name / role / save */}
          <div class="sd-head">
            <input
              class="sd-name"
              value={draft.name}
              maxLength={40}
              spellcheck={false}
              onInput={(ev) => update({ name: (ev.target as HTMLInputElement).value, nameDirty: true })}
              aria-label="Design name"
            />
            <span class="sd-role" style={{ borderColor: ROLE_COLOR[role], color: ROLE_COLOR[role] }} data-tip="Role is inferred from the parts: colony/outpost/invasion modules first, then weapons, otherwise scout.">
              {ROLE_LABEL[role]}
            </span>
            {saved && !dirty && <span class="chip good">Saved</span>}
            {saved && dirty && <span class="chip warn">Unsaved changes</span>}
            {!saved && <span class="chip">New draft</span>}
            <div class="spacer" />
            {saved && <button class="btn sm" onClick={() => save(true)} data-tip="Keep the original and save this as a separate design">Save as new</button>}
            <button class="btn primary" onClick={() => save(false)} disabled={!!saved && !dirty}>
              <Icon.save size={15} />{saved ? 'Update design' : 'Save design'}
            </button>
          </div>

          {/* Hull picker */}
          <div class="sd-hulls">
            {knownHulls.map((h) => (
              <button
                key={h.id}
                class={'sd-hull' + (h.id === draft.hull ? ' on' : '') + (isNew(h.tech) ? ' new' : '')}
                onClick={() => changeHull(h.id)}
                data-tip={`${h.name}\n${h.slots} slots · ${h.hp} hull points · mass ${h.mass}\nBase cost ${h.cost}. Heavier hulls need more drives for the same speed.`}
              >
                <ShipImage species={human.species} hull={h.id} color={human.color} size={28} />
                <span class="sd-hull-name ellipsis">{h.name.replace(' Hull', '')}</span>
                <span class="sd-hull-meta"><b>{h.slots}</b> slots · {h.hp}hp · <span class="ind">{h.cost}</span></span>
              </button>
            ))}
          </div>

          <div class="sd-work">
            {/* Ship + slots */}
            <section class="sd-ship">
              <div class="sd-hero">
                {classicImg
                  ? <img src={classicImg} alt={hull.name} draggable={false} />
                  : <ShipImage species={human.species} hull={draft.hull} color={human.color} size={170} />}
                <div class="sd-hero-tag">
                  <span class="caps">{sp.adjective} {hull.name}</span>
                  <span class="dim tiny">{draft.parts.filter(Boolean).length}/{hull.slots} slots filled</span>
                </div>
              </div>

              <div class="sd-slots-head">
                <span class="caps">Slots</span>
                <div class="spacer" />
                <span class="faint tiny">click slot → click part · right-click clears · shift-click fills all empty</span>
              </div>
              <div class="sd-slots">
                {draft.parts.map((id, i) => {
                  const p = id ? PART[id] : null;
                  const unpowered = !!p && !stats.powered[i];
                  const ks = p ? keyStat(p, luminous) : null;
                  return (
                    <div
                      key={i}
                      class={'sd-slot' + (sel === i ? ' on' : '') + (unpowered ? ' off' : '') + (p ? '' : ' empty')}
                      style={p ? { ['--cat' as string]: CAT_COLOR[p.category] } as JSX.CSSProperties : undefined}
                      onClick={() => { setSel(i); if (p) setCat(p.category); }}
                      onContextMenu={(ev) => { ev.preventDefault(); if (p) clearSlot(i); }}
                      data-tip={p ? partTip(p, luminous, false) + (unpowered ? '\n\n⚠ UNPOWERED — this part does nothing. Add a generator or move it above other power users.' : '') : undefined}
                    >
                      <span class="sd-slot-n">{i + 1}</span>
                      <PartIcon id={id} size={30} />
                      <div class="grow">
                        <div class="ellipsis">{p ? p.name : <span class="faint">{sel === i ? 'Pick a part →' : 'Empty slot'}</span>}</div>
                        {p && (
                          <div class="tiny dim ellipsis">
                            {ks!.main} {ks!.sub}
                            {p.category !== 'generator' && p.power > 0 && <> · <span class={unpowered ? 'bad' : ''}>⚡{p.power}</span></>}
                          </div>
                        )}
                      </div>
                      {unpowered && <span class="sd-nopower" data-tip="Not enough power supply reaches this slot.">NO POWER</span>}
                      {p && (
                        <span class="sd-slot-tools">
                          <button class="btn ghost sm sd-mini" disabled={i === 0} onClick={(ev) => { ev.stopPropagation(); moveSlot(i, -1); }} data-tip="Move up (power is allocated top to bottom)"><Icon.up size={12} /></button>
                          <button class="btn ghost sm sd-mini" disabled={i === draft.parts.length - 1} onClick={(ev) => { ev.stopPropagation(); moveSlot(i, 1); }} data-tip="Move down"><Icon.down size={12} /></button>
                          <button class="btn ghost sm sd-mini" onClick={(ev) => { ev.stopPropagation(); clearSlot(i); }} data-tip="Clear slot (Del)"><Icon.close size={12} /></button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div class="row wrap" style={{ gap: 6, marginTop: 8 }}>
                <button class="btn sm ghost" onClick={() => { setParts(draft.parts.map(() => '')); setSel(0); }} disabled={!draft.parts.some(Boolean)}>
                  <Icon.trash size={13} />Clear all
                </button>
                {saved && dirty && (
                  <button class="btn sm ghost" onClick={() => openDesign(saved)} data-tip="Discard unsaved changes">Revert</button>
                )}
              </div>
            </section>

            {/* Stats */}
            <section class="sd-stats">
              <div class="sd-auto">
                <span class="caps">Auto-design for this hull</span>
                <div class="sd-auto-btns">
                  {AUTO_ROLES.map((a) => {
                    const ok = !a.needs || PARTS.some((p) => p.special === a.needs && w.knows(e, p.tech));
                    return (
                      <button key={a.role} class="btn sm" disabled={!ok} onClick={() => autoDesign(a.role)} data-tip={ok ? `${a.tip}\nFills every slot on the ${hull.name.toLowerCase()} with your best parts.` : 'Requires research to unlock the module.'}>
                        <span class="sd-role-dot" style={{ background: ROLE_COLOR[a.role] }} />{a.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <StatsPanel
                stats={stats}
                parts={draft.parts}
                compare={compareStats}
                compareLabel={compareLabel}
                compareId={compareId}
                designs={myDesigns.filter((d) => d.id !== draft.id)}
                onCompare={setCompareId}
              />
            </section>
          </div>
        </main>

        {/* ---------------- right: part picker ---------------- */}
        <aside class="sd-picker">
          <div class="sd-tabs">
            {CATEGORIES.map((c) => {
              const n = sortedParts[c.id].length;
              const hasNew = sortedParts[c.id].some((p) => isNew(p.tech));
              return (
                <button key={c.id} class={'sd-tab' + (cat === c.id ? ' on' : '')} onClick={() => setCat(c.id)} data-tip={`${c.label} (key ${c.key})`} style={{ ['--cat' as string]: CAT_COLOR[c.id] } as JSX.CSSProperties}>
                  <i />{c.label}<span class="faint">{n}</span>{hasNew && <b class="sd-newdot" />}
                </button>
              );
            })}
          </div>
          <div class="sd-picker-head">
            <span class="tiny dim">{sel != null ? <>Filling slot <b class="accent">{sel + 1}</b>{selPart ? ` (replaces ${PART[selPart].name})` : ''}</> : 'Select a slot, or click to fill the first empty one'}</span>
            <div class="spacer" />
            <div class="seg">
              <button class={sortBy === 'best' ? 'on' : ''} onClick={() => setSortBy('best')} data-tip="Best first (value per power), newest wins ties">Best</button>
              <button class={sortBy === 'new' ? 'on' : ''} onClick={() => setSortBy('new')} data-tip="Most recently researched first">New</button>
              <button class={sortBy === 'cost' ? 'on' : ''} onClick={() => setSortBy('cost')} data-tip="Cheapest first">Cost</button>
            </div>
          </div>
          <div class="sd-parts scroll">
            {sortedParts[cat].map((p, idx) => {
              const ks = keyStat(p, luminous);
              const fresh = isNew(p.tech);
              const inUse = draft.parts.filter((x) => x === p.id).length;
              return (
                <button
                  key={p.id}
                  class={'sd-part' + (selPart === p.id ? ' on' : '')}
                  style={{ ['--cat' as string]: CAT_COLOR[p.category] } as JSX.CSSProperties}
                  onClick={(ev) => place(p.id, ev.shiftKey)}
                  data-tip={partTip(p, luminous, fresh) + '\n\nClick: place in selected slot · Shift-click: fill all empty slots'}
                >
                  <PartIcon id={p.id} size={36} />
                  <div class="grow sd-part-text">
                    <div class="row" style={{ gap: 6 }}>
                      <span class="ellipsis sd-part-name">{p.name}</span>
                      {fresh && <span class="sd-new">NEW</span>}
                      {idx === 0 && sortBy === 'best' && cat !== 'special' && <span class="sd-best">BEST</span>}
                    </div>
                    <div class="tiny dim ellipsis">
                      {p.category === 'generator' ? <span class="good">supplies ⚡{p.power + (luminous ? 1 : 0)}</span> : p.power ? <>⚡{p.power}</> : <span class="good">no power</span>}
                      {' · '}<span class="ind">{p.cost}</span>
                      {inUse > 0 && <> · <span class="accent">×{inUse} fitted</span></>}
                    </div>
                  </div>
                  <div class="sd-part-stat">
                    <b>{ks.main}</b>
                    {ks.sub && <span>{ks.sub}</span>}
                  </div>
                </button>
              );
            })}
            {sortedParts[cat].length === 0 && <div class="dim small" style={{ padding: 16, textAlign: 'center' }}>Nothing researched in this category yet.</div>}
          </div>
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DesignRow({ d, human, count, on, comparing, onOpen, onCompare }: { d: ShipDesign; human: Empire; count: number; on: boolean; comparing: boolean; onOpen: () => void; onCompare: () => void }) {
  const h = HULL[d.hull];
  return (
    <div class={'sd-drow' + (on ? ' on' : '') + (d.obsolete ? ' obs' : '')} onClick={onOpen}>
      <ShipImage species={human.species} hull={d.hull} color={human.color} size={28} />
      <div class="grow">
        <div class="ellipsis sd-drow-name">{d.name}</div>
        <div class="tiny faint">{h?.name.replace(' Hull', '')} · day {d.created}</div>
      </div>
      <span class={'sd-count' + (count ? '' : ' zero')} data-tip={`${count} ship${count === 1 ? '' : 's'} in service`}>{count}</span>
      <button
        class={'btn ghost sm sd-mini' + (comparing ? ' active' : '')}
        onClick={(ev) => { ev.stopPropagation(); onCompare(); }}
        data-tip={comparing ? 'Stop comparing' : 'Compare with the current draft'}
      >
        <Icon.chart size={12} />
      </button>
    </div>
  );
}

function StatsPanel(props: {
  stats: ShipStats;
  parts: string[];
  compare?: ShipStats;
  compareLabel?: string;
  compareId: number | null;
  designs: ShipDesign[];
  onCompare: (id: number | null) => void;
}) {
  const { stats: s, compare: c } = props;
  const demand = powerDemand(props.parts);
  const short = demand > s.powerSupply;
  const days = daysPerLane(s.speed);
  const dud = s.speed === 0 || !props.parts.some(Boolean);

  const specials: { k: string; label: string; tip: string }[] = [];
  if (s.colony) specials.push({ k: 'col', label: `Colony ×${s.colony}`, tip: 'Can found a colony (module consumed).' });
  if (s.outpost) specials.push({ k: 'out', label: `Outpost ×${s.outpost}`, tip: 'Can claim a planet as an outpost (kit consumed).' });
  if (s.invasion) specials.push({ k: 'inv', label: `Troops ×${s.invasion}`, tip: 'Invasion modules for seizing enemy planets.' });
  if (s.repair) specials.push({ k: 'rep', label: 'Self-repair', tip: 'Repairs 15% hull per day and between combat rounds.' });
  if (s.cloak) specials.push({ k: 'clk', label: 'Cloaked', tip: 'Invisible unless enemy deep scanners are nearby (every ship in the fleet needs one).' });
  if (s.laneDrive) specials.push({ k: 'lane', label: 'Red lanes', tip: 'Can cross unstable lanes.' });
  if (s.tractor) specials.push({ k: 'trc', label: 'Grapple', tip: 'Stops enemies retreating from battle.' });
  if (s.jammer) specials.push({ k: 'jam', label: 'Jammer', tip: 'Enemies hit this ship 25% less often.' });

  return (
    <div class="sd-statbox">
      {s.warnings.length > 0 && (
        <div class={'sd-warn' + (dud ? ' dud' : '')}>
          <b>{dud ? 'Dud design' : 'Design warnings'}</b>
          {dud && <div class="tiny">This ship could be built, but it can't do its job.</div>}
          <ul>{s.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <div class="sd-compare-bar">
        <span class="caps">Performance</span>
        <div class="spacer" />
        <select
          value={props.compareId ?? ''}
          onChange={(ev) => { const v = (ev.target as HTMLSelectElement).value; props.onCompare(v ? Number(v) : null); }}
          aria-label="Compare with design"
        >
          <option value="">{props.compareLabel === 'Saved version' ? 'vs. saved version' : 'Compare with…'}</option>
          {props.designs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.obsolete ? ' (obsolete)' : ''}</option>)}
        </select>
      </div>

      <table class="sd-table">
        {c && (
          <thead><tr><th /><th>This</th><th class="sd-vs ellipsis">{props.compareLabel}</th></tr></thead>
        )}
        <tbody>
          <StatRow label="Cost" icon={<Icon.ind size={13} />} v={s.cost} cv={c?.cost} lowerBetter tip="Industry needed to build one ship." />
          <StatRow label="Hull" icon={<Icon.ship size={13} />} v={s.hp} cv={c?.hp} tip="Hull points, including armor." />
          <StatRow label="Shields" icon={<Icon.shield size={13} />} v={s.shield} cv={c?.shield} tip="Damage absorbed per combat round (regenerates)." digits={1} />
          <StatRow label="Attack" icon={<Icon.sword size={13} />} v={s.attack} cv={c?.attack} tip={s.weapons.length ? 'Damage × shots per round:\n' + s.weapons.map((x) => `${PART[x.part].name}: ${fmt(x.damage, 1)} × ${x.shots} · range ${x.range}`).join('\n') : 'No working weapons.'} digits={1} />
          <StatRow label="Speed" icon={<Icon.route size={13} />} v={s.speed} cv={c?.speed} digits={2} tip={`Raw speed = drive thrust ÷ hull mass.\n≈ ${isFinite(days) ? days : '∞'} days to cross a typical ${LANE}-unit lane.`}
            extra={<span class="dim tiny">{isFinite(days) ? `≈${days}d / lane` : 'immobile'}</span>} />
          <StatRow label="Scan" icon={<Icon.eye size={13} />} v={s.scan} cv={c?.scan} tip="Sensor range in map units." />
          {s.weapons.length > 0 && (
            <StatRow label="Range" icon={<Icon.target size={13} />} v={Math.max(...s.weapons.map((x) => x.range))} cv={c && c.weapons.length ? Math.max(...c.weapons.map((x) => x.range)) : c ? 0 : undefined} tip="Longest weapon range: you fire first at this distance." />
          )}
        </tbody>
      </table>

      <div class="sd-power">
        <div class="row">
          <Icon.bolt size={14} class={short ? 'bad' : 'good'} />
          <span class="caps">Power</span>
          <div class="spacer" />
          <span class={'mono small ' + (short ? 'bad' : '')}>{demand} needed / {s.powerSupply} supplied</span>
        </div>
        <Bar value={demand} max={Math.max(s.powerSupply, demand, 1)} color={short ? 'var(--bad)' : demand === s.powerSupply ? 'var(--warn)' : 'var(--good)'} style={{ height: 8, marginTop: 6 }} />
        <div class="tiny faint" style={{ marginTop: 4 }}>
          {short ? `Short by ${demand - s.powerSupply} — lower slots lose power first.` : s.powerSupply - demand > 0 ? `${s.powerSupply - demand} spare power.` : demand ? 'Exactly balanced.' : 'Nothing draws power.'}
        </div>
      </div>

      <div class="sd-abil">
        <span class="caps">Abilities</span>
        <div class="row wrap" style={{ gap: 5, marginTop: 6 }}>
          {specials.length ? specials.map((x) => <span key={x.k} class="chip good" data-tip={x.tip}>{x.label}</span>) : <span class="faint tiny">None</span>}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, icon, v, cv, tip, lowerBetter, digits = 0, extra }: { label: string; icon: JSX.Element; v: number; cv?: number; tip: string; lowerBetter?: boolean; digits?: number; extra?: JSX.Element }) {
  const f = (n: number) => (digits && n % 1 ? n.toFixed(digits) : fmt(n));
  let delta: JSX.Element | null = null;
  if (cv !== undefined) {
    const d = v - cv;
    const good = lowerBetter ? d < 0 : d > 0;
    delta = Math.abs(d) < 1e-6
      ? <span class="faint">=</span>
      : <span class={good ? 'good' : 'bad'}>{d > 0 ? '+' : '−'}{f(Math.abs(d))}</span>;
  }
  return (
    <tr data-tip={tip}>
      <td class="sd-lbl"><span class="row" style={{ gap: 6 }}>{icon}{label}</span></td>
      <td class="sd-val"><b>{f(v)}</b> {extra}{delta && <span class="sd-delta">{delta}</span>}</td>
      {cv !== undefined && <td class="sd-val dim">{f(cv)}</td>}
    </tr>
  );
}

// ---------------------------------------------------------------------------

const CSS = `
.sd-root { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 236px minmax(0, 1fr) 330px; }
.sd-root .accent { color: var(--accent); }
.sd-list, .sd-picker { display: flex; flex-direction: column; min-height: 0; background: rgba(5, 8, 18, 0.35); }
.sd-list { border-right: 1px solid var(--line); }
.sd-picker { border-left: 1px solid var(--line); }
.sd-list-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 6px; }
.sd-list-actions { display: flex; gap: 4px; padding: 0 10px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.sd-list-actions .btn { flex: 1; }
.sd-list-body { flex: 1; min-height: 0; padding: 6px; }
.sd-group { margin-bottom: 6px; }
.sd-group-title { display: flex; align-items: center; gap: 6px; padding: 6px 6px 4px; font-family: var(--display); font-size: 11.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim); }
.sd-group-title .faint { margin-left: auto; font-family: var(--font); }
.sd-toggle { width: 100%; background: none; border: 0; cursor: pointer; text-align: left; }
.sd-toggle:hover { color: var(--text); }
.sd-role-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
.sd-drow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.sd-drow:hover { background: var(--panel-3); }
.sd-drow.on { border-color: var(--accent); background: rgba(127, 220, 255, 0.1); }
.sd-drow.obs { opacity: .5; filter: grayscale(.7); }
.sd-drow.obs:hover, .sd-drow.obs.on { opacity: .85; }
.sd-drow-name { font-size: 13px; font-weight: 500; }
.sd-count { min-width: 22px; text-align: center; font-size: 11px; font-variant-numeric: tabular-nums; padding: 1px 6px; border-radius: 999px; background: rgba(127, 220, 255, .15); color: var(--accent); }
.sd-count.zero { background: transparent; color: var(--text-faint); }
.sd-mini { padding: 3px; width: 22px; height: 22px; }
.sd-drow .sd-mini { opacity: 0; }
.sd-drow:hover .sd-mini, .sd-drow .sd-mini.active { opacity: 1; }

.sd-main { min-width: 0; min-height: 0; padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.sd-refit { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(127, 220, 255, .5); background: linear-gradient(90deg, rgba(40, 120, 170, .25), rgba(40, 60, 120, .12)); color: var(--accent); }
.sd-refit > .grow { color: var(--text); }
.sd-refit.away { border-color: rgba(255, 207, 106, .5); background: linear-gradient(90deg, rgba(150, 110, 30, .22), rgba(60, 50, 30, .1)); color: var(--warn); }
.sd-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sd-name { font-family: var(--display); font-size: 18px; font-weight: 600; letter-spacing: .03em; min-width: 140px; flex: 1 1 160px; max-width: 320px; background: rgba(0, 0, 0, .25); border-color: var(--line-2); padding: 6px 10px; }
.sd-name:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(127, 220, 255, .15); }
.sd-role { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; border: 1px solid; background: rgba(0, 0, 0, .25); }

.sd-hulls { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 6px; }
.sd-hull { position: relative; display: grid; grid-template-columns: 28px 1fr; grid-template-rows: auto auto; column-gap: 7px; align-items: center; text-align: left; padding: 6px 7px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); cursor: pointer; transition: border-color .12s, background .12s; }
.sd-hull img { grid-row: span 2; }
.sd-hull:hover { border-color: var(--line-2); }
.sd-hull.on { border-color: var(--accent); background: rgba(127, 220, 255, .12); box-shadow: 0 0 16px rgba(127, 220, 255, .12); }
.sd-hull-name { font-family: var(--display); font-weight: 600; font-size: 13px; }
.sd-hull-meta { font-size: 10px; line-height: 1.3; color: var(--text-dim); }
.sd-hull { min-width: 0; overflow: hidden; }
.sd-hull > * { min-width: 0; }
.sd-hull.new::after { content: 'NEW'; position: absolute; top: -5px; right: 6px; font-size: 8px; font-weight: 800; background: var(--accent); color: #002; padding: 0 4px; border-radius: 3px; }

.sd-work { display: grid; grid-template-columns: minmax(250px, 1.1fr) minmax(240px, 1fr); gap: 14px; align-items: start; }
.sd-ship { min-width: 0; }
.sd-hero { position: relative; height: 170px; border-radius: 12px; border: 1px solid var(--line); overflow: hidden; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 55%, rgba(80, 120, 220, .22), transparent 65%), repeating-linear-gradient(0deg, rgba(127, 220, 255, .04) 0 1px, transparent 1px 22px), repeating-linear-gradient(90deg, rgba(127, 220, 255, .04) 0 1px, transparent 1px 22px), rgba(3, 6, 14, .8); }
.sd-hero img { max-width: 92%; max-height: 150px; object-fit: contain; filter: drop-shadow(0 6px 18px rgba(0, 0, 0, .7)) drop-shadow(0 0 20px rgba(127, 220, 255, .15)); }
.sd-hero-tag { position: absolute; left: 10px; bottom: 8px; display: flex; flex-direction: column; gap: 1px; }
.sd-slots-head { display: flex; align-items: baseline; gap: 8px; margin: 12px 0 6px; flex-wrap: wrap; }
.sd-slots { display: flex; flex-direction: column; gap: 3px; }
.sd-slot { --cat: var(--line-2); position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 8px; border-radius: 8px; border: 1px solid var(--line); border-left: 3px solid var(--cat); background: var(--panel-2); cursor: pointer; min-height: 42px; transition: border-color .1s, background .1s; }
.sd-slot:hover { background: var(--panel-3); }
.sd-slot.empty { background: rgba(10, 14, 28, .5); border-style: dashed; border-left-style: solid; border-left-color: var(--line); }
.sd-slot.on { border-color: var(--accent); border-left-color: var(--accent); background: rgba(127, 220, 255, .12); box-shadow: 0 0 0 1px rgba(127, 220, 255, .25); }
.sd-slot.off { border-color: rgba(255, 107, 107, .55); background: rgba(120, 30, 40, .22); }
.sd-slot.off img, .sd-slot.off svg { opacity: .55; }
.sd-slot-n { width: 16px; text-align: right; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.sd-slot img, .sd-slot > svg { width: 30px; height: 30px; flex-shrink: 0; }
.sd-nopower { font-size: 9px; font-weight: 800; letter-spacing: .06em; color: #fff; background: var(--bad); border-radius: 4px; padding: 1px 5px; }
.sd-slot-tools { display: flex; gap: 0; opacity: 0; transition: opacity .1s; }
.sd-slot:hover .sd-slot-tools, .sd-slot.on .sd-slot-tools { opacity: 1; }

.sd-stats { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.sd-auto { padding: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); }
.sd-auto-btns { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.sd-auto-btns .btn { flex: 1 1 auto; }
.sd-statbox { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); }
.sd-warn { border: 1px solid rgba(255, 207, 106, .55); background: rgba(120, 90, 20, .22); border-radius: 8px; padding: 8px 10px; color: var(--warn); font-size: 12.5px; }
.sd-warn.dud { border-color: rgba(255, 107, 107, .7); background: rgba(130, 25, 35, .3); color: #ffb3b3; animation: sd-pulse 2.4s ease-in-out infinite; }
.sd-warn b { font-family: var(--display); letter-spacing: .06em; text-transform: uppercase; font-size: 12px; }
.sd-warn ul { margin: 4px 0 0; padding-left: 18px; color: var(--text); }
@keyframes sd-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0); } 50% { box-shadow: 0 0 14px 0 rgba(255, 107, 107, .25); } }
.sd-compare-bar { display: flex; align-items: center; gap: 8px; }
.sd-compare-bar select { font-size: 12px; padding: 3px 6px; max-width: 170px; }
.sd-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.sd-table th { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-faint); text-align: right; font-weight: 600; padding: 0 4px 4px; max-width: 90px; }
.sd-table td { padding: 5px 4px; border-bottom: 1px solid rgba(130, 160, 255, .07); }
.sd-table tr:last-child td { border-bottom: 0; }
.sd-lbl { color: var(--text-dim); font-size: 12.5px; }
.sd-val { text-align: right; white-space: nowrap; }
.sd-val b { font-size: 14px; color: #fff; }
.sd-delta { display: inline-block; min-width: 34px; margin-left: 6px; font-size: 11px; text-align: right; }
.sd-power { padding-top: 2px; }

.sd-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 10px; border-bottom: 1px solid var(--line); }
.sd-tab { --cat: var(--accent); position: relative; display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--text-dim); cursor: pointer; font-family: var(--display); font-size: 12.5px; letter-spacing: .03em; }
.sd-tab i { width: 8px; height: 8px; border-radius: 2px; background: var(--cat); opacity: .8; transform: rotate(45deg); }
.sd-tab .faint { margin-left: auto; font-family: var(--font); font-size: 11px; }
.sd-tab:hover { color: var(--text); border-color: var(--line-2); }
.sd-tab.on { color: #fff; border-color: var(--cat); background: color-mix(in srgb, var(--cat) 14%, transparent); }
.sd-newdot { position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.sd-picker-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.sd-parts { flex: 1; min-height: 0; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.sd-part { --cat: var(--accent); display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 7px 10px 7px 8px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel-2); cursor: pointer; transition: border-color .1s, background .1s, transform .05s; }
.sd-part:hover { border-color: var(--cat); background: color-mix(in srgb, var(--cat) 10%, var(--panel-2)); }
.sd-part:active { transform: translateY(1px); }
.sd-part.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px rgba(127, 220, 255, .3); }
.sd-part img, .sd-part > svg { width: 36px; height: 36px; flex-shrink: 0; }
.sd-part-text { min-width: 0; }
.sd-part-name { font-weight: 600; font-size: 13px; }
.sd-part-stat { display: flex; flex-direction: column; align-items: flex-end; min-width: 54px; font-variant-numeric: tabular-nums; }
.sd-part-stat b { font-family: var(--display); font-size: 16px; color: var(--cat); line-height: 1.1; }
.sd-part-stat span { font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: .06em; }
.sd-new, .sd-best { font-size: 8.5px; font-weight: 800; letter-spacing: .05em; padding: 1px 4px; border-radius: 3px; flex-shrink: 0; }
.sd-new { background: var(--accent); color: #002; box-shadow: 0 0 8px rgba(127, 220, 255, .5); }
.sd-best { border: 1px solid var(--warn); color: var(--warn); }

@media (max-width: 1180px) {
  .sd-root { grid-template-columns: 200px minmax(0, 1fr) 290px; }
  .sd-work { grid-template-columns: 1fr; }
}
@media (max-width: 920px) {
  .sd-root { grid-template-columns: minmax(0, 1fr) 270px; grid-template-rows: auto minmax(0, 1fr); }
  .sd-list { grid-column: 1 / -1; border-right: 0; border-bottom: 1px solid var(--line); flex-direction: row; align-items: stretch; max-height: 116px; }
  .sd-list-head { display: none; }
  .sd-list-actions { flex-direction: column; flex-wrap: nowrap; padding: 8px; border-bottom: 0; border-right: 1px solid var(--line); }
  .sd-list-body { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; }
  .sd-group { display: flex; flex-direction: column; flex-wrap: wrap; min-width: 180px; margin: 0; }
  .sd-tabs { grid-template-columns: repeat(2, 1fr); }
}
`;
