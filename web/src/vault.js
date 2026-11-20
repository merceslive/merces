// The Merces vault: a refractive glass vessel holding liquid mercury. One fixed canvas for the whole site.
// Driven only through this API (one clock: gsap.ticker); see DESIGN.md "Concept card".
//   level(frac)  real fill, 0..1 (mapped from ETH waiting by the caller)
//   drop()       a mercury drop falls in (real events, and the illustrated "pour" chapter)
//   pose(name)   where the vault stands: 'hero' | 'park' | 'stage' | 'aside'
//   stage(p)     0..1 progress through the three "how" chapters (name, pour, open)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gsap } from 'gsap';

const POSES = {
  hero: { x: 2.55, y: 0.95, s: 0.82, ry: -0.42, dim: 1 },
  heroNarrow: { x: 0, y: 1.55, s: 0.62, ry: -0.42, dim: 1 },
  park: { x: 3.4, y: 1.7, s: 0.46, ry: -0.9, dim: 0.55 },
  parkNarrow: { x: 1.15, y: 2.6, s: 0.3, ry: -0.9, dim: 0.5 },
  stage: { x: 1.9, y: -0.15, s: 0.95, ry: -0.2, dim: 1 },
  stageNarrow: { x: 0, y: 1.05, s: 0.6, ry: -0.2, dim: 1 },
  aside: { x: 3.6, y: -0.6, s: 0.8, ry: -0.7, dim: 0.42 },
  asideNarrow: { x: 1.4, y: 2.9, s: 0.34, ry: -0.7, dim: 0.35 },
};

export function createVault(canvas, { onSlow, onReady } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const narrowMq = matchMedia('(max-width: 760px)');
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, narrowMq.matches ? 1.25 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.transmissionResolutionScale = narrowMq.matches ? 0.5 : 0.75;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#07080A');
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 0.2, 11);

  // Lab strip lights: they are what the chrome mercury reflects and what the glass refracts.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.background = new THREE.Color('#030405');
  const strip = (w, h, x, y, z, k) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
  };
  strip(0.7, 14, -6, 0, 3, 7);
  strip(0.7, 14, 6, 0, -2, 5);
  strip(14, 0.6, 0, 7, 0, 2.2);
  strip(10, 4, 0, 3, 8, 2.6);
  strip(4, 1.2, 0, -4, 6, 1.2);
  strip(0.3, 10, -2, 0, -7, 2);
  const envTex = pmrem.fromScene(env, 0.02).texture;
  scene.environment = envTex;

  // Visible backdrop: a softly lit wall and vertical light bars behind the vault, so the glass has something to bend.
  const wallTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    // Opaque on purpose: the transmission pass only sees opaque objects, so this is what the glass bends.
    g.fillStyle = '#07080A'; g.fillRect(0, 0, 512, 512);
    const rg = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    rg.addColorStop(0, '#4A545B'); rg.addColorStop(0.45, '#1F2428'); rg.addColorStop(1, '#07080A');
    g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ map: wallTex, toneMapped: false }));
  wall.position.z = -4;
  scene.add(wall);
  const bars = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const w = i % 3 === 0 ? 0.08 : 0.025;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 26), new THREE.MeshBasicMaterial({ color: new THREE.Color('#DDE8EE').multiplyScalar(0.07 + (i % 3) * 0.06), toneMapped: false }));
    m.position.set(-1.2 + i * 0.6, 0, -3.6 + (i % 2) * 0.3);
    bars.add(m);
  }
  scene.add(bars);

  const rig = new THREE.Group();
  scene.add(rig);

  const W = 2.2, H = 3.1, D = 2.2, WALL = 0.16;
  const glass = new THREE.Mesh(
    new RoundedBoxGeometry(W, H, D, 6, 0.32),
    new THREE.MeshPhysicalMaterial({
      color: '#FFFFFF', metalness: 0, roughness: 0.035, transmission: 1, thickness: 0.9, ior: 1.5,
      dispersion: 4, clearcoat: 1, clearcoatRoughness: 0.02, specularIntensity: 1, envMapIntensity: 1.3,
      attenuationColor: new THREE.Color('#E8F1F4'), attenuationDistance: 6,
    }),
  );
  rig.add(glass);

  // Mercury: a rounded block cut by a moving surface h(x,z,t). Back faces above nothing are drawn as the surface.
  const inner = { w: W - WALL * 2, h: H - WALL * 2, d: D - WALL * 2 };
  const uniforms = {
    uLevel: { value: -inner.h / 2 + 0.06 },
    uTime: { value: 0 },
    uTilt: { value: new THREE.Vector2() },
    uAmp: { value: 0.02 },
    uRipple: { value: 0 },
    uNM: { value: new THREE.Matrix3() },
  };
  const merc = new THREE.MeshPhysicalMaterial({ color: '#F1F5F7', metalness: 1, roughness: 0.16, envMapIntensity: 3.4, side: THREE.DoubleSide });
  merc.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLocal; uniform float uLevel, uTime, uAmp, uRipple; uniform vec2 uTilt; uniform mat3 uNM;
        float surf(vec2 p){
          float r = length(p);
          return uLevel + dot(p, uTilt)
            + uAmp * (sin(p.x*3.1 + uTime*1.7) * 0.6 + sin(p.y*2.7 - uTime*1.3) * 0.4 + sin((p.x+p.y)*5.0 + uTime*2.3) * 0.25)
            + uRipple * sin(r*9.0 - uTime*9.0) * exp(-r*1.4);
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float hh = surf(vLocal.xz);
        if (vLocal.y > hh) discard;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (!gl_FrontFacing) {
          float e = 0.01;
          vec3 n = normalize(vec3(-(surf(vLocal.xz+vec2(e,0.))-hh)/e, 1.0, -(surf(vLocal.xz+vec2(0.,e))-hh)/e));
          normal = normalize(uNM * n);
        }`);
  };
  const mercury = new THREE.Mesh(new RoundedBoxGeometry(inner.w, inner.h, inner.d, 4, 0.18), merc);
  mercury.onBeforeRender = () => { uniforms.uNM.value.getNormalMatrix(mercury.modelViewMatrix); };
  rig.add(mercury);

  // Drops.
  const dropGeo = new THREE.SphereGeometry(0.075, 24, 16);
  const drops = [];
  const dropMat = new THREE.MeshPhysicalMaterial({ color: '#E3EAEE', metalness: 1, roughness: 0.05, envMapIntensity: 1.6 });

  // State the outside drives, and the smoothed state we draw.
  const target = { level: 0.02, pose: 'hero', stage: -1 };
  const cur = { level: 0, x: POSES.hero.x, y: POSES.hero.y, s: 0.9, ry: POSES.hero.ry, dim: 1 };
  const pointer = { x: 0, y: 0, vx: 0 };
  let lastPX = 0;
  const onMove = (e) => {
    const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
    pointer.vx += (nx - lastPX) * 2.2; lastPX = nx;
    pointer.x = nx; pointer.y = ny;
  };
  addEventListener('pointermove', onMove, { passive: true });

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w < 760 ? 13 : 11;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const lerp = (a, b, t) => a + (b - a) * t;
  let t = 0, slosh = 0, sloshV = 0, ripple = 0;
  // Too slow to hold the frame (software GL, an old phone): give up and let the page show the still image.
  const frames = [];
  let gaveUp = false;
  let skip = false;
  const tick = (_time, deltaMs) => {
    if (gaveUp) return;
    if ((target.pose === 'park' || target.pose === 'aside') && frames.length >= 45) { skip = !skip; if (skip) return; }
    if (frames.length < 45) {
      frames.push(deltaMs || 16);
      if (frames.length === 45) {
        const med = [...frames].slice(10).sort((a, b) => a - b)[17];
        if (med > 70 && onSlow) { gaveUp = true; gsap.ticker.remove(tick); onSlow(); return; }
      }
    }
    const dt = Math.min((deltaMs || 16) / 1000, 0.05);
    t += dt;
    const p = POSES[narrowMq.matches ? `${target.pose}Narrow` : target.pose] || POSES.hero;
    const k = 1 - Math.pow(0.0015, dt);
    cur.x = lerp(cur.x, p.x, k); cur.y = lerp(cur.y, p.y, k); cur.s = lerp(cur.s, p.s, k);
    cur.ry = lerp(cur.ry, p.ry, k); cur.dim = lerp(cur.dim, p.dim, k);

    // Chapter overrides (illustration of the mechanism, never a number).
    let lvl = target.level;
    if (target.stage >= 0) {
      const sp = target.stage;
      lvl = sp < 0.33 ? 0.04 : sp < 0.66 ? 0.04 + ((sp - 0.33) / 0.33) * 0.7 : 0.74 - Math.min(1, (sp - 0.66) / 0.25) * 0.7;
    }
    cur.level = lerp(cur.level, lvl, 1 - Math.pow(0.02, dt));

    rig.position.set(cur.x, cur.y, 0);
    rig.scale.setScalar(cur.s);
    rig.rotation.y = cur.ry + Math.sin(t * 0.25) * 0.08 + pointer.x * 0.35;
    rig.rotation.x = pointer.y * 0.18 + Math.sin(t * 0.33) * 0.02;
    rig.rotation.z = -pointer.x * 0.05;

    // Slosh: a damped spring pushed by pointer velocity.
    sloshV += (-slosh * 22 - sloshV * 3.2 + pointer.vx * 40) * dt;
    slosh += sloshV * dt; pointer.vx *= Math.pow(0.02, dt);
    ripple *= Math.pow(0.25, dt);
    uniforms.uTime.value = t;
    uniforms.uLevel.value = -inner.h / 2 + 0.05 + cur.level * (inner.h - 0.2);
    uniforms.uTilt.value.set(slosh * 0.32 + rig.rotation.z * 0.6, -rig.rotation.x * 0.3);
    uniforms.uAmp.value = 0.012 + Math.min(0.05, Math.abs(sloshV) * 0.02);
    uniforms.uRipple.value = ripple;

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.v -= 9.8 * dt * 0.55; d.m.position.y += d.v * dt;
      if (d.m.position.y < uniforms.uLevel.value) { rig.remove(d.m); drops.splice(i, 1); ripple = Math.min(0.06, ripple + 0.035); }
    }
    bars.position.set(cur.x * 0.9 + pointer.x * -0.4, cur.y * 0.4, 0);
    bars.scale.set(0.5 + cur.s * 0.5, 1, 1);
    wall.position.set(cur.x * 0.9, cur.y * 0.9, -4); wall.scale.setScalar(0.25 + cur.s * 0.25);
    renderer.toneMappingExposure = 0.45 + cur.dim * 0.85;
    renderer.render(scene, camera);
    if (frames.length === 45 && onReady) { const f = onReady; onReady = null; f(); }
  };
  gsap.ticker.add(tick);

  return {
    level(frac) { target.level = Math.max(0.16, Math.min(0.92, frac)); },
    pose(name) { target.pose = name; target.stage = name === 'stage' ? Math.max(0, target.stage) : -1; },
    stage(p) { target.stage = p; },
    drop() {
      if (drops.length > 12) return;
      const m = new THREE.Mesh(dropGeo, dropMat);
      m.position.set((Math.random() - 0.5) * 0.8, H / 2 + 1.6, (Math.random() - 0.5) * 0.6);
      rig.add(m); drops.push({ m, v: 0 });
    },
    destroy() {
      gsap.ticker.remove(tick);
      removeEventListener('pointermove', onMove); removeEventListener('resize', resize);
      renderer.dispose(); envTex.dispose(); pmrem.dispose();
    },
  };
}
