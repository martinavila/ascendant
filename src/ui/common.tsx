import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { store } from './store';
import { Icon } from './icons';
import { LONG_PRESS_MS } from '../render/device';

export const fmt = (n: number, digits = 0) => {
  if (!isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(digits);
};

export const plural = (n: number, word: string, pl = word + 's') => `${n} ${n === 1 ? word : pl}`;

/** Full-screen modal used by every "screen" (research, designer, diplomacy...). */
export function Modal(props: { title: ComponentChildren; onClose?: () => void; children: ComponentChildren; actions?: ComponentChildren; width?: string; height?: string }) {
  const close = props.onClose ?? (() => store.open('none'));
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div class="overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="panel modal" style={{ width: props.width, height: props.height }}>
        <div class="modal-head">
          <h2>{props.title}</h2>
          <div class="spacer" />
          {props.actions}
          <button class="btn icon ghost modal-close" onClick={close} data-tip="Close (Esc)" aria-label="Close"><Icon.close /></button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Bar({ value, max, color, style }: { value: number; max: number; color?: string; style?: JSX.CSSProperties }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <div class="bar" style={style}><i style={{ width: pct + '%', background: color }} /></div>;
}

export function Stat({ icon, value, tip, class: cls }: { icon: JSX.Element; value: ComponentChildren; tip?: string; class?: string }) {
  return <span class={'stat ' + (cls ?? '')} data-tip={tip}>{icon}<span>{value}</span></span>;
}

export function Yields({ ind, res, pro, size = 14 }: { ind: number; res: number; pro: number; size?: number }) {
  return (
    <span class="row" style={{ gap: 10 }}>
      <Stat icon={Icon.ind({ size })} value={fmt(ind, ind < 10 && ind % 1 ? 1 : 0)} tip="Industry: builds structures and ships on this planet" />
      <Stat icon={Icon.res({ size })} value={fmt(res, res < 10 && res % 1 ? 1 : 0)} tip="Research: pooled across the empire" />
      <Stat icon={Icon.pro({ size })} value={fmt(pro, pro < 10 && pro % 1 ? 1 : 0)} tip="Prosperity: grows population on this planet" />
    </span>
  );
}

/**
 * Global tooltip: any element with data-tip="..." gets a styled tooltip.
 * Mouse: on hover. Touch/pen: on long-press (a normal tap never shows one, and
 * the click that would follow a long-press is swallowed so it doesn't also act).
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; touch?: boolean } | null>(null);
  useEffect(() => {
    let cur: Element | null = null;
    let lastTouch = 0;
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    let swallowUntil = 0;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = 0; start = null; };
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || performance.now() - lastTouch < 800) return;
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (!el) { if (cur) { cur = null; setTip(null); } return; }
      const text = el.getAttribute('data-tip');
      if (!text) return;
      cur = el;
      setTip({ text, x: e.clientX, y: e.clientY });
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimer();
      if (e.pointerType === 'mouse' && cur) setTip((t) => (t && !t.touch ? { ...t, x: e.clientX, y: e.clientY } : t));
    };
    const down = (e: PointerEvent) => {
      swallowUntil = 0;
      cur = null;
      setTip(null);
      clearTimer();
      if (e.pointerType === 'mouse') return;
      lastTouch = performance.now();
      const el = (e.target as Element)?.closest?.('[data-tip]');
      const text = el?.getAttribute('data-tip');
      if (!text) return;
      start = { x: e.clientX, y: e.clientY };
      const x = e.clientX, y = e.clientY;
      timer = window.setTimeout(() => {
        timer = 0;
        start = null;
        swallowUntil = performance.now() + 1500;
        navigator.vibrate?.(8);
        setTip({ text, x, y, touch: true });
      }, LONG_PRESS_MS);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') lastTouch = performance.now();
      clearTimer();
    };
    // A long-press that showed a tooltip must not also "click" the element.
    const click = (e: MouseEvent) => {
      if (performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); swallowUntil = 0; }
    };
    // Long-press on touch fires contextmenu on Android; never let it trigger right-click actions.
    const ctx = (e: MouseEvent) => {
      if (performance.now() - lastTouch < 1500 && !(e.target as Element)?.closest?.('input,textarea')) { e.preventDefault(); e.stopPropagation(); }
    };
    const hide = () => { cur = null; clearTimer(); setTip((t) => (t && t.touch ? t : null)); };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('click', click, true);
    window.addEventListener('contextmenu', ctx, true);
    window.addEventListener('wheel', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      clearTimer();
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('contextmenu', ctx, true);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);
  // Touch tooltips hide themselves after a while (the next tap also hides them).
  useEffect(() => {
    if (!tip?.touch) return;
    const t = setTimeout(() => setTip(null), 6000);
    return () => clearTimeout(t);
  }, [tip]);
  if (!tip) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const maxW = Math.min(320, vw - 16);
  let left: number, top: number | undefined, bottom: number | undefined;
  if (tip.touch) {
    // Above the finger, centred, clamped to the screen.
    left = Math.max(8, Math.min(tip.x - maxW / 2, vw - maxW - 8));
    if (tip.y > 140) bottom = vh - tip.y + 28;
    else top = tip.y + 36;
  } else {
    left = Math.max(8, Math.min(tip.x + 14, vw - maxW - 10));
    top = tip.y + 18 + 80 > vh ? tip.y - 60 : tip.y + 18;
  }
  return <div class={'tooltip' + (tip.touch ? ' touch' : '')} style={{ left, top, bottom, maxWidth: maxW }}>{tip.text}</div>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="dim small" style={{ padding: 16, textAlign: 'center' }}>{children}</div>;
}

export function Section({ title, right, children, class: cls }: { title: ComponentChildren; right?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <div class={'section ' + (cls ?? '')}>
      <div class="section-title"><h3>{title}</h3><div class="spacer" />{right}</div>
      {children}
    </div>
  );
}

/** Run a command result and toast any error. */
export function act(r: { ok: boolean; error?: string } | void | null | undefined, success?: string) {
  if (r && !r.ok) store.notify(r.error ?? 'Not possible.', 'error');
  else if (success) store.notify(success);
  store.emit();
}
