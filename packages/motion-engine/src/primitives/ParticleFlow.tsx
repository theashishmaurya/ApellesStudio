/**
 * ParticleFlow — tokens streaming, memory being written, dissolve / assemble.
 *
 * Render it INSIDE a <Scene3D> (or any @remotion/three <ThreeCanvas>) — it's a
 * <points> cloud driven by a ShaderMaterial whose only animated input is a
 * frame-derived `uProgress`. No accumulated state → deterministic.
 *
 * presets:
 *   stream   — a continuous river of points from `from` → `to` (loops)
 *   converge — points fly in from a scatter sphere and assemble into `shape`
 *   disperse — the reverse: `shape` dissolves into scatter
 *
 *   <Scene3D camera={...}>
 *     <ParticleFlow preset="stream" from={[-4,0,0]} to={[4,0,0]} count={1600} />
 *   </Scene3D>
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import * as THREE from "three";
import { design } from "../design";
import { mulberry32 } from "../lib/rng";

type Vec3 = [number, number, number];

const shapePoint = (
  shape: "sphere" | "ring" | "grid",
  i: number,
  n: number,
  size: number,
  rnd: () => number,
): Vec3 => {
  if (shape === "ring") {
    const a = (i / n) * Math.PI * 2;
    const r = size * (0.9 + rnd() * 0.15);
    return [Math.cos(a) * r, Math.sin(a) * r, (rnd() - 0.5) * size * 0.1];
  }
  if (shape === "grid") {
    const side = Math.ceil(Math.sqrt(n));
    const gx = (i % side) / (side - 1) - 0.5;
    const gy = Math.floor(i / side) / (side - 1) - 0.5;
    return [gx * size * 2, gy * size * 2, (rnd() - 0.5) * size * 0.08];
  }
  // sphere (fibonacci)
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  const r = size * (0.92 + rnd() * 0.12);
  return [
    Math.sin(phi) * Math.cos(theta) * r,
    Math.sin(phi) * Math.sin(theta) * r,
    Math.cos(phi) * r,
  ];
};

const vert = /* glsl */ `
  attribute vec3 aSource;
  attribute vec3 aTarget;
  attribute vec3 aRand;
  attribute float aT;
  uniform float uProgress;
  uniform float uMode;   // 0 = stream, 1 = morph
  uniform vec3  uA;
  uniform vec3  uB;
  uniform float uSize;
  varying float vAlpha;

  void main() {
    vec3 p;
    if (uMode < 0.5) {
      float f = fract(aT + uProgress);
      p = mix(uA, uB, f);
      p += aRand * 0.9 * sin(f * 6.2831 + aT * 12.0);
      vAlpha = sin(f * 3.14159);
    } else {
      float local = clamp(uProgress * 1.25 + (aT - 0.5) * 0.4, 0.0, 1.0);
      p = mix(aSource, aTarget, local);
      vAlpha = 0.25 + 0.55 * local;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (260.0 / -mv.z), 1.0, 9.0);
  }
`;

const frag = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    float soft = smoothstep(0.25, 0.02, d);
    gl_FragColor = vec4(uColor, vAlpha * soft * 0.2);
  }
`;

export const ParticleFlow: React.FC<{
  preset: "stream" | "converge" | "disperse";
  count?: number;
  start?: number;
  dur?: number;
  from?: Vec3;
  to?: Vec3;
  shape?: "sphere" | "ring" | "grid";
  shapeSize?: number;
  center?: Vec3;
  scatter?: number;
  color?: string;
  size?: number;
  seed?: number;
}> = ({
  preset,
  count = 900,
  start = 0,
  dur = 60,
  from = [-4, 0, 0],
  to = [4, 0, 0],
  shape = "sphere",
  shapeSize = 2,
  center = [0, 0, 0],
  scatter = 6,
  color = design.accentBlue,
  size = 5,
  seed = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const geom = useMemo(() => {
    const rnd = mulberry32(seed);
    const src = new Float32Array(count * 3);
    const tgt = new Float32Array(count * 3);
    const rand = new Float32Array(count * 3);
    const ts = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      rand.set([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], i * 3);
      const scat: Vec3 = [
        (rnd() - 0.5) * scatter,
        (rnd() - 0.5) * scatter,
        (rnd() - 0.5) * scatter,
      ];
      const sp = shapePoint(shape, i, count, shapeSize, rnd);
      const shapeAbs: Vec3 = [sp[0] + center[0], sp[1] + center[1], sp[2] + center[2]];
      const a = preset === "disperse" ? shapeAbs : scat;
      const b = preset === "disperse" ? scat : shapeAbs;
      src.set(a, i * 3);
      tgt.set(b, i * 3);
      ts[i] = rnd();
    }
    const g = new THREE.BufferGeometry();
    // position is required but unused (shader computes it) — fill with source
    g.setAttribute("position", new THREE.BufferAttribute(src.slice(), 3));
    g.setAttribute("aSource", new THREE.BufferAttribute(src, 3));
    g.setAttribute("aTarget", new THREE.BufferAttribute(tgt, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(rand, 3));
    g.setAttribute("aT", new THREE.BufferAttribute(ts, 1));
    return g;
  }, [count, preset, shape, shapeSize, scatter, seed, center]);

  const stream = preset === "stream";
  const progress = stream
    ? ((frame - start) / fps) * 0.35
    : interpolate(frame, [start, start + dur], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.bezier(...design.ease.inOut),
      });

  const uniforms = useMemo(
    () => ({
      uProgress: { value: 0 },
      uMode: { value: stream ? 0 : 1 },
      uA: { value: new THREE.Vector3(...from) },
      uB: { value: new THREE.Vector3(...to) },
      uSize: { value: size },
      uColor: { value: new THREE.Color(color) },
    }),
    [stream, from, to, size, color],
  );
  uniforms.uProgress.value = progress;

  return (
    <points geometry={geom}>
      <shaderMaterial
        vertexShader={vert}
        fragmentShader={frag}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
};
