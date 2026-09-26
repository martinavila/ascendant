import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { store } from './store';
import { Icon } from './icons';

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
          <button class="btn icon ghost" onClick={close} data-tip="Close (Esc)"><Icon.close /></button>
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

/** Global tooltip: any element with data-tip="..." gets a styled tooltip. */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let cur: Element | null = null;
    const over = (e: MouseEvent) => {
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (!el) { if (cur) { cur = null; setTip(null); } return; }
      const text = el.getAttribute('data-tip');
      if (!text) return;
      cur = el;
      setTip({ text, x: e.clientX, y: e.clientY });
    };
    const move = (e: MouseEvent) => { if (cur) setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t)); };
    const hide = () => { cur = null; setTip(null); };
    window.addEventListener('mouseover', over);
    window.addEventListener('mousemove', move);
    window.addEventListener('pointerdown', hide);
    window.addEventListener('wheel', hide);
    return () => {
      window.removeEventListener('mouseover', over);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('pointerdown', hide);
      window.removeEventListener('wheel', hide);
    };
  }, []);
  if (!tip) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 330);
  const top = tip.y + 18 + 80 > window.innerHeight ? tip.y - 60 : tip.y + 18;
  return <div class="tooltip" style={{ left, top }}>{tip.text}</div>;
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
