"use client";

/**
 * components/hud/AxiemGlass.tsx
 *
 * The Axiem mark as a real-time refractive glass object (Three.js). The three
 * blades are extruded from the logo paths; deviation knocks each blade out of
 * alignment ("dislocate"). The current A-Game state word is rendered on a plane
 * BEHIND the glass, so the crystal refracts it. Pure presentation — driven by
 * props derived from the live dashboard snapshot.
 *
 * Load this only on the client via next/dynamic({ ssr:false }). It self-handles:
 *   • prefers-reduced-motion → no rotation, a single static frame
 *   • no WebGL2 → graceful SVG fallback (the solid mark)
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export type GlassMode = "live" | "calibrating" | "disconnected";

export interface AxiemGlassProps {
  /** Per-blade dislocation 0..1 (0 = assembled, 1 = fully knocked out of alignment). */
  intensity: { freq: number; pace: number; size: number };
  /** Sentence-case state word shown behind the glass (e.g. "Aligned"). */
  label: string;
  mode?: GlassMode;
  /** Optional fixed width in px. Defaults to a responsive hero size. */
  size?: number;
  /** Fill the parent element instead of using an intrinsic width. */
  fill?: boolean;
}

const BLADE_D = {
  freq: "M453.236 407.657C406.964 467.478 334.481 505.998 253 505.998C172.221 505.998 100.284 468.141 53.9639 409.201C60.5202 413.487 68.2783 415.998 76.7441 415.998H428.238C437.675 415.998 446.238 412.877 453.236 407.657Z",
  pace: "M253.93 0C393.23 0.501111 506 113.58 506 252.998C506 300.54 492.886 345.019 470.079 383.016C472.654 374.113 472.761 364.229 469.657 354.454H469.707C445.772 278.789 392.68 145.164 289.453 21.0225C283.1 10.6422 273.004 3.63365 261.923 1.05176C261.381 0.946389 260.84 0.84072 260.298 0.735352C259.855 0.630003 259.362 0.525365 258.919 0.472656C258.229 0.367279 257.589 0.314355 256.899 0.208984C256.506 0.208984 256.112 0.103594 255.718 0.103516C255.138 0.103516 254.511 0.0516484 253.93 0Z",
  size: "M250.061 0.0146484C249.775 0.0286961 249.491 0.0546892 249.217 0.103516C248.823 0.103516 248.428 0.208984 248.034 0.208984C247.345 0.261672 246.705 0.367305 246.016 0.472656C245.572 0.525348 245.079 0.629968 244.636 0.735352C244.094 0.840712 243.552 0.946398 243.011 1.05176C231.93 3.63368 221.883 10.6423 215.48 21.0225C112.352 145.164 59.3097 278.789 35.3252 354.454C32.5765 363.155 32.3635 371.944 34.166 380.049C12.442 342.712 0 299.308 0 252.998C0 114.251 111.687 1.58996 250.061 0.0146484Z",
} as const;
const ORDER = ["freq", "pace", "size"] as const;
type Blade = (typeof ORDER)[number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function AxiemGlass({ intensity, label, mode = "live", size, fill }: AxiemGlassProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ intensity, label, mode });
  propsRef.current = { intensity, label, mode };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!document.createElement("canvas").getContext("webgl2")) { setFailed(true); return; }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch { setFailed(true); return; }

    let W = wrap.clientWidth || 320, H = wrap.clientHeight || W;
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060709);
    const camera = new THREE.PerspectiveCamera(34, W / H, 0.1, 100);
    camera.position.set(0, 0, 6.8);

    // ── studio environment (self-contained) ──
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x05060a);
    const lightPlane = (w: number, h: number, color: number, intensityV: number, pos: [number, number, number], rot?: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensityV), side: THREE.DoubleSide }));
      m.position.set(pos[0], pos[1], pos[2]); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); studio.add(m);
    };
    lightPlane(12, 12, 0xffffff, 2.4, [0, 9, 4], [-Math.PI / 2.3, 0, 0]);
    lightPlane(9, 9, 0xffd6a0, 1.5, [-9, 1, 3], [0, Math.PI / 2.5, 0]);
    lightPlane(9, 9, 0xa9c6ff, 1.1, [9, -1, -3], [0, -Math.PI / 2.5, 0]);
    lightPlane(0.45, 9, 0xffffff, 6.0, [-2.4, 2.5, 6], [0, 0, 0.32]);
    lightPlane(0.45, 9, 0xffffff, 6.0, [3.2, -1, 6], [0, 0, -0.44]);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(studio, 0.015).texture;
    scene.environment = envTex;

    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(4, 5, 6); scene.add(key);
    const warm = new THREE.DirectionalLight(0xffce9a, 2.0); warm.position.set(-5, -1, 3); scene.add(warm);
    const cool = new THREE.DirectionalLight(0x9ec6ff, 1.2); cool.position.set(0, -4, -4); scene.add(cool);

    // ── glass material (constant in every state) ──
    const makeMat = () => {
      const m = new THREE.MeshPhysicalMaterial({
        transmission: 1, ior: 1.52, thickness: 1.4, roughness: 0.03, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.05,
        attenuationColor: new THREE.Color(0xe9f1ff), attenuationDistance: 3.0,
        specularIntensity: 1, envMapIntensity: 1.75,
        iridescence: 0.3, iridescenceIOR: 1.32, iridescenceThicknessRange: [120, 460],
        side: THREE.DoubleSide,
      });
      (m as unknown as { dispersion: number }).dispersion = 3.6;
      return m;
    };

    const group = new THREE.Group();
    scene.add(group);
    const blades: Record<Blade, THREE.Mesh> = {} as Record<Blade, THREE.Mesh>;
    const disposables: { dispose: () => void }[] = [];

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 506 506">${ORDER.map((k) => `<path d="${BLADE_D[k]}"/>`).join("")}</svg>`;
    const data = new SVGLoader().parse(svg);
    const S = 1 / 150;
    data.paths.forEach((path, i) => {
      const shapes = SVGLoader.createShapes(path);
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: 82, bevelEnabled: true, bevelThickness: 2.5, bevelSize: 1.5, bevelSegments: 1, curveSegments: 60 });
      geo.center(); geo.computeVertexNormals();
      const mat = makeMat();
      const mesh = new THREE.Mesh(geo, mat);
      disposables.push(geo, mat);
      const tmp = new THREE.ExtrudeGeometry(SVGLoader.createShapes(path), { depth: 1 });
      tmp.computeBoundingBox();
      const c = new THREE.Vector3(); tmp.boundingBox!.getCenter(c); tmp.dispose();
      const dir = new THREE.Vector2(c.x - 253, c.y - 253); if (dir.lengthSq() < 1e-4) dir.set(0, 1); dir.normalize();
      mesh.userData = { dir, base: c.clone().sub(new THREE.Vector3(253, 253, 0)), idx: i, cur: 0.05 };
      mesh.position.copy(mesh.userData.base as THREE.Vector3);
      blades[ORDER[i]] = mesh;
      group.add(mesh);
    });
    group.scale.set(S, -S, S);

    // ── state word rendered behind the glass (refracted) ──
    const stateCanvas = document.createElement("canvas"); stateCanvas.width = stateCanvas.height = 1024;
    const sctx = stateCanvas.getContext("2d")!;
    const stateTex = new THREE.CanvasTexture(stateCanvas); stateTex.colorSpace = THREE.SRGBColorSpace;
    const backdropMat = new THREE.MeshBasicMaterial({ map: stateTex });
    const backdropGeo = new THREE.PlaneGeometry(9, 9);
    const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
    backdrop.position.set(0, 0, -1.7);
    scene.add(backdrop);
    disposables.push(backdropGeo, backdropMat, stateTex);

    let lastLabel = "";
    const drawState = (text: string) => {
      const w = 1024, cx = 512, cy = 512, x = sctx;
      const g = x.createRadialGradient(cx, 450, 30, cx, cy, 540);
      g.addColorStop(0, "#161a21"); g.addColorStop(0.55, "#0b0d12"); g.addColorStop(1, "#060709");
      x.fillStyle = g; x.fillRect(0, 0, w, w);
      x.strokeStyle = "rgba(255,255,255,0.045)"; x.lineWidth = 2;
      x.beginPath(); x.arc(cx, cy, 332, 0, Math.PI * 2); x.stroke();
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillStyle = "rgba(228,232,238,0.34)";
      x.font = "500 60px Inter, system-ui, sans-serif";
      x.fillText(text, cx, cy);
      stateTex.needsUpdate = true;
      lastLabel = text;
    };
    drawState(label);

    // ── postprocessing ──
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bokeh = new BokehPass(scene, camera, { focus: 6.8, aperture: 0.00055, maxblur: 0.006 });
    composer.addPass(bokeh);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.62, 0.55, 0.84));
    composer.addPass(new OutputPass());

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const sizeRenderer = () => {
      W = wrap.clientWidth || 320; H = wrap.clientHeight || W;
      renderer.setSize(W, H); composer.setSize(W, H);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      if (reduced) composer.render();
    };
    const ro = new ResizeObserver(sizeRenderer);
    ro.observe(wrap);

    const applyBlades = (t: number, lerp: boolean) => {
      const { intensity: inten } = propsRef.current;
      ORDER.forEach((k) => {
        const m = blades[k];
        const ud = m.userData as { dir: THREE.Vector2; base: THREE.Vector3; idx: number; cur: number };
        const target = clamp01(inten[k]);
        ud.cur = lerp ? ud.cur + (target - ud.cur) * 0.08 : target;
        const p = ud.cur;
        const push = p * 46;
        const zoff = (ud.idx - 1) * p * 24;
        m.position.set(ud.base.x + ud.dir.x * push, ud.base.y + ud.dir.y * push, ud.base.z + zoff);
        m.rotation.z = p * 0.16 * (ud.dir.x > 0 ? -1 : 1);
      });
    };

    let raf = 0;
    const render = (ms: number) => {
      const t = ms / 1000;
      if (propsRef.current.label !== lastLabel) drawState(propsRef.current.label);
      const spinning = !reduced && propsRef.current.mode !== "disconnected";
      if (spinning) { group.rotation.y = Math.sin(t * 0.32) * 0.42; group.rotation.x = Math.sin(t * 0.24) * 0.10; }
      applyBlades(t, true);
      composer.render();
      raf = requestAnimationFrame(render);
    };

    if (reduced) {
      group.rotation.set(0.08, 0.28, 0);
      applyBlades(0, false);
      composer.render();
    } else {
      raf = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposables.forEach((d) => d.dispose());
      envTex.dispose(); pmrem.dispose();
      composer.dispose?.();
      renderer.dispose();
      if (renderer.domElement.parentNode === wrap) wrap.removeChild(renderer.domElement);
    };
  }, []);

  const wrapStyle: React.CSSProperties = fill
    ? { position: "relative", width: "100%", height: "100%" }
    : { position: "relative", width: size ? `${size}px` : "min(360px, 86vw)", aspectRatio: "1" };

  if (failed) {
    // graceful fallback: the solid mark + label, no WebGL
    return (
      <div style={{ ...wrapStyle, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 506 506" width="62%" height="62%" style={{ opacity: 0.5 }}>
          {ORDER.map((k) => <path key={k} d={BLADE_D[k]} fill="#3A4049" />)}
        </svg>
        <div style={{ position: "absolute", fontSize: 15, color: "rgba(228,232,238,0.6)", fontFamily: "Inter, system-ui, sans-serif" }}>{label}</div>
      </div>
    );
  }

  return <div ref={wrapRef} style={wrapStyle} />;
}
