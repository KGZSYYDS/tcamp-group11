import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const DAY = 1440;
const CENTER = 200;
const WAVE_HEIGHT = 17;
const WAVE_RADIUS = 240;

type Sample = { minute: number; x: number; y: number };
type Curve = { radius: number; samples: Sample[]; rest: string };
type OrbitBand = Curve & { id: string };
type WaveTarget = { minute: number; strength: number };

function sample(minute: number): Sample {
  const angle = minute / DAY * 2 * Math.PI - Math.PI / 2;
  return { minute, x: Math.cos(angle), y: Math.sin(angle) };
}

function coordinate(value: number) {
  return Math.round(value * 100) / 100;
}

function at({ x, y }: Sample, radius: number) {
  return { x: coordinate(CENTER + x * radius), y: coordinate(CENTER + y * radius) };
}

export function orbitPoint(minute: number, radius: number) {
  return at(sample(minute), radius);
}

export const ORBIT_RIM = "M 200 24 A 176 176 0 1 1 200 376 A 176 176 0 1 1 200 24 Z";
export const ORBIT_HOURS = Array.from({ length: 8 }, (_, i) => sample(i * 180));
const rimSamples = Array.from({ length: 144 }, (_, i) => sample(i * 10));
const ticks = Array.from({ length: 96 }, (_, i) => sample(i * 15));
const minorTicks = ticks.filter(({ minute }) => minute % 60 !== 0);
const majorTicks = ticks.filter(({ minute }) => minute % 60 === 0);

function shortestDistance(from: number, to: number) {
  return (to - from + DAY * 1.5) % DAY - DAY / 2;
}

// 两端的位移和斜率都为零。波峰和两侧的小波谷接回同一条圆周。
function offset(minute: number, crest: number, height: number) {
  const distance = shortestDistance(crest, minute) / WAVE_RADIUS;
  if (Math.abs(distance) >= 1) return 0;
  const edge = 1 - distance * distance;
  return height * edge * edge * (1 - 3 * distance * distance);
}

function curvePath(samples: Sample[], radius: number, crest: number, height: number) {
  return samples.map((point, index) => {
    const { x, y } = at(point, radius + offset(point.minute, crest, height));
    return `${index ? "L" : "M"}${x} ${y}`;
  }).join(" ");
}

function tickPath(major: boolean, crest = 0, height = 0) {
  return (major ? majorTicks : minorTicks).map((point) => {
    const shift = offset(point.minute, crest, height);
    const start = at(point, 177 + shift);
    const end = at(point, (major ? 184 : 180) + shift);
    return `M${start.x} ${start.y}L${end.x} ${end.y}`;
  }).join(" ");
}

export const ORBIT_MINOR_TICKS = tickPath(false);
export const ORBIT_MAJOR_TICKS = tickPath(true);

export function orbitBand(id: string, start: number, end: number, lane: number): OrbitBand {
  const radius = 161 - (lane % 4) * 15;
  const inset = Math.min(1, (end - start) / 8);
  const from = start + inset;
  const to = Math.min(end - inset, from + DAY - 0.01);
  const first = orbitPoint(from, radius);
  const last = orbitPoint(to, radius);
  const segments = Math.max(1, Math.ceil((to - from) / 10));
  return {
    id, radius,
    samples: Array.from({ length: segments + 1 }, (_, i) => sample(from + (to - from) * i / segments)),
    rest: `M ${first.x} ${first.y} A ${radius} ${radius} 0 ${to - from > 720 ? 1 : 0} 1 ${last.x} ${last.y}`,
  };
}

function updateAttribute(node: Element | null, name: string, value: string) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function useOrbitWave(svg: RefObject<SVGSVGElement>, bands: OrbitBand[], reduced: boolean) {
  const control = useRef<((target: WaveTarget | null, immediately?: boolean) => void) | null>(null);
  const wave = useRef({ crest: 0, height: 0, target: 0, targetHeight: 0 });

  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const rim = root.querySelector(".orbit-outline");
    const minor = root.querySelector(".orbit-tick:not(.major)");
    const major = root.querySelector(".orbit-tick.major");
    const hours = Array.from(root.querySelectorAll("[data-orbit-hour]"));
    const groups = new Map(Array.from(root.querySelectorAll("[data-orbit-event]"))
      .map((group) => [group.getAttribute("data-orbit-event"), Array.from(group.querySelectorAll("path"))]));
    const state = wave.current;
    let frame: number | null = null;
    let previousFrame = 0;

    function paint() {
      const { crest, height } = state;
      updateAttribute(rim, "d", height ? curvePath(rimSamples, 176, crest, height) + " Z" : ORBIT_RIM);
      updateAttribute(minor, "d", height ? tickPath(false, crest, height) : ORBIT_MINOR_TICKS);
      updateAttribute(major, "d", height ? tickPath(true, crest, height) : ORBIT_MAJOR_TICKS);
      hours.forEach((hour, index) => {
        const point = ORBIT_HOURS[index];
        const position = at(point, 194 + offset(point.minute, crest, height));
        updateAttribute(hour, "x", String(position.x));
        updateAttribute(hour, "y", String(position.y));
      });
      for (const band of bands) {
        const moves = height && band.samples.some(({ minute }) => Math.abs(shortestDistance(crest, minute)) < WAVE_RADIUS);
        const path = moves ? curvePath(band.samples, band.radius, crest, height) : band.rest;
        groups.get(band.id)?.forEach((element) => updateAttribute(element, "d", path));
      }
    }

    function animate(time: number) {
      frame = null;
      const elapsed = previousFrame ? Math.min(time - previousFrame, 32) : 16;
      previousFrame = time;
      const turn = shortestDistance(state.crest, state.target);
      state.crest = Math.abs(turn) < 0.5
        ? state.target
        : (state.crest + turn * (1 - Math.exp(-elapsed / 22)) + DAY) % DAY;
      const rise = state.targetHeight - state.height;
      state.height = Math.abs(rise) < 0.06
        ? state.targetHeight
        : state.height + rise * (1 - Math.exp(-elapsed / (rise < 0 ? 78 : 52)));
      paint();
      if (state.height !== state.targetHeight || (state.height && state.crest !== state.target)) {
        frame = requestAnimationFrame(animate);
      } else {
        previousFrame = 0;
      }
    }

    control.current = (target, immediately = false) => {
      state.targetHeight = target && !reduced ? WAVE_HEIGHT * target.strength : 0;
      if (target && state.targetHeight) {
        state.target = target.minute;
        if (!state.height) state.crest = target.minute;
      }
      if (immediately || reduced) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        previousFrame = 0;
        state.height = state.targetHeight;
        paint();
      } else if (frame === null && (state.height !== state.targetHeight || (state.height && state.crest !== state.target))) {
        frame = requestAnimationFrame(animate);
      }
    };
    if (reduced) control.current(null, true);
    else if (state.height || state.targetHeight) frame = requestAnimationFrame(animate);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      control.current = null;
    };
  }, [bands, reduced, svg]);

  return control;
}
