/**
 * Scene3D — real camera moves + depth, on top of @remotion/three.
 *
 * "Fly through the transformer", stacked network layers, context window as a space.
 * Deterministic: the camera is a pure function of `useCurrentFrame()`; no OrbitControls,
 * no physics, no time-based anything.
 *
 * <Scene3D camera={[{at, pos:[x,y,z], look:[x,y,z]}, ...]}>
 *   <LabelBox .../> <LayerStack .../> ...custom meshes...
 * </Scene3D>
 *
 * Bloom note: @react-three/postprocessing's <EffectComposer> needs
 * @react-three/fiber >= 9.7, but @remotion/three pins fiber 9.2 — the composer
 * silently renders black. So glow here is done in-scene with additive halo meshes
 * (<Glow>), which is deterministic and needs no extra deps. Add screen-space
 * grain/vignette with the 2D <FilmGrain>/<Vignette> overlays from ./postfx.
 *
 * Gotchas (Remotion docs):
 *  - a <Sequence> placed *inside* Scene3D must use layout="none"
 *  - SSR render needs chromiumOptions:{gl:"angle"} — set in remotion.config.ts,
 *    pass it explicitly when rendering via the Node APIs
 */
import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { design } from "../design";

export type CamKey = {
  at: number;
  pos: [number, number, number];
  look?: [number, number, number];
  ease?: readonly [number, number, number, number];
};

const cb = (c: readonly [number, number, number, number]) =>
  Easing.bezier(c[0], c[1], c[2], c[3]);

const lerp3 = (a: number[], b: number[], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const CameraRig: React.FC<{ keys: CamKey[] }> = ({ keys }) => {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  const first = sorted[0];

  let a = first;
  let b = first;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].at <= frame) {
      a = sorted[i];
      b = sorted[i + 1] ?? sorted[i];
    }
  }
  const t =
    a.at === b.at
      ? 1
      : interpolate(frame, [a.at, b.at], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: cb(b.ease ?? design.ease.inOut),
        });

  const pos = lerp3(a.pos, b.pos, t);
  const look = lerp3(a.look ?? [0, 0, 0], b.look ?? [0, 0, 0], t);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateProjectionMatrix();
  return null;
};

export const Scene3D: React.FC<{
  camera: CamKey[];
  children: React.ReactNode;
  fov?: number;
}> = ({ camera, children, fov = 45 }) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: design.bg }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov, position: camera[0]?.pos ?? [0, 0, 8] }}
        gl={{ toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <color attach="background" args={[design.bg]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 8, 6]} intensity={1.4} />
        <pointLight position={[-6, -3, -4]} intensity={0.5} color={design.accentBlue} />
        <CameraRig keys={camera} />
        {children}
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

/** soft radial-falloff texture for glow sprites — built once, deterministic */
let _glowTex: THREE.CanvasTexture | null = null;
const glowTexture = (): THREE.CanvasTexture | null => {
  if (typeof document === "undefined") return null;
  if (_glowTex) return _glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
};

/** additive halo behind a bright object — a bloom stand-in that needs no composer */
export const Glow: React.FC<{
  position?: [number, number, number];
  radius?: number;
  color?: string;
  strength?: number;
}> = ({ position = [0, 0, 0], radius = 1.6, color = design.accentBlue, strength = 0.6 }) => (
  <sprite position={position} scale={[radius * 2.6, radius * 2.6, 1]}>
    <spriteMaterial
      map={glowTexture() ?? undefined}
      color={color}
      opacity={strength}
      transparent
      blending={THREE.AdditiveBlending}
      depthWrite={false}
    />
  </sprite>
);

/** a labelled rounded box — the workhorse 3D "thing" */
export const LabelBox: React.FC<{
  position?: [number, number, number];
  size?: [number, number, number];
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
}> = ({
  position = [0, 0, 0],
  size = [2, 1.2, 0.4],
  color = design.bgDeep,
  emissive = design.accentBlue,
  emissiveIntensity = 0,
}) => (
  <group position={position}>
    {emissiveIntensity > 0 && (
      <Glow radius={Math.max(size[0], size[1]) * 0.9} color={emissive} strength={emissiveIntensity * 0.5} />
    )}
    <mesh>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.6}
        metalness={0.1}
      />
    </mesh>
  </group>
);

/** a stack of planes — model architecture / the caching stack */
export const LayerStack: React.FC<{
  count?: number;
  gap?: number;
  size?: [number, number];
  position?: [number, number, number];
  /** index that lifts + glows (drive from the composition with a frame condition) */
  active?: number;
  lift?: number;
}> = ({
  count = 5,
  gap = 0.55,
  size = [3.4, 2],
  position = [0, 0, 0],
  active = -1,
  lift = 0.4,
}) => {
  const total = (count - 1) * gap;
  return (
    <group position={position}>
      {Array.from({ length: count }).map((_, i) => {
        const isActive = i === active;
        const y = -total / 2 + i * gap + (isActive ? lift : 0);
        return (
          <group key={i} position={[0, y, 0]}>
            {isActive && <Glow radius={size[0] * 0.6} color={design.accentRed} strength={0.5} />}
            <mesh rotation={[-Math.PI / 2.6, 0, 0]}>
              <planeGeometry args={size} />
              <meshStandardMaterial
                color={design.bgDeep}
                emissive={isActive ? design.accentRed : design.strokeSoft}
                emissiveIntensity={isActive ? 0.9 : 0.06}
                side={THREE.DoubleSide}
                transparent
                opacity={0.92}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
};
