// Device capability hints shared by the 2D (PixiJS) and 3D (three.js) renderers.
// Phones and small tablets get a lower pixel ratio and cheaper effects so the
// map stays smooth on mobile GPUs and doesn't drain the battery.

const mq = (q: string) => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;

/** True on touch-first devices (no fine pointer). */
export const coarsePointer = () => mq('(pointer: coarse)') && !mq('(any-pointer: fine)');

/** Phones, small tablets and other touch-first devices. */
export const lowPower = () => {
  if (typeof window === 'undefined') return false;
  const small = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight) < 820;
  return coarsePointer() || small;
};

/** Device pixel ratio to render at: capped at 1.5 on low-power devices, 2 elsewhere. */
export const renderPixelRatio = () => Math.min(lowPower() ? 1.5 : 2, window.devicePixelRatio || 1);

/** Long-press delay for touch context actions and tooltips (ms). */
export const LONG_PRESS_MS = 480;

/** Height (px) of a bottom sheet covering the map, so focusing can keep the target visible above it. */
export const bottomOcclusion = () => {
  if (typeof document === 'undefined') return 0;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')) || 0;
};
