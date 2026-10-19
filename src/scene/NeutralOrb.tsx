import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'
import { useStore } from '../store'

/**
 * The default orb: neutral, no logo, rendered to look like a Blender still.
 *
 * One sphere does nearly all of it in its fragment shader:
 *   - a glowing plasma volume inside, raymarched through the sphere in object
 *     space: curling 3D simplex fbm, densest towards the core, swirling;
 *   - a glass shell over it: fresnel rim, a thin-film iridescent sheen that
 *     only lives at grazing angles, and two soft specular highlights;
 *   - ACES filmic tone mapping applied in the shader, so this orb rolls off
 *     like a render while the other styles keep their neon clip.
 * The vertex shader adds a slow organic wobble and, while she speaks, ripples
 * that travel over the surface with her voice level. A faint halo of motes
 * orbits around it.
 *
 * Neutral palette: cool silver-white core; pink and violet only in the rim
 * and glow, so it sits in the plum UI without being a logo.
 *
 *   idle       slow breathing
 *   listening  brightens with the mic level
 *   thinking   the plasma swirls faster and shifts violet
 *   speaking   surface ripples driven by her TTS amplitude
 */

const NOISE = /* glsl */ `
  // Ashima 3D simplex noise (MIT).
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uSpeak;
  uniform float uBreath;
  uniform vec3 uPointer;   // unit direction on the sphere under the cursor (object space)
  uniform float uHover;    // 0..1, eased in while the cursor is over the orb
  uniform vec3 uClickPos;  // where the last click landed
  uniform float uClickAge; // seconds since that click (large = none)
  varying vec3 vPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  ${NOISE}
  void main() {
    vec3 p = position;
    // Slow organic wobble, so the silhouette is never a perfect CG sphere.
    float wob = snoise(p * 1.6 + vec3(0.0, uTime * 0.25, 0.0)) * 0.018;
    // Speaking: ripples travelling over the surface from two poles.
    float ripple = sin(dot(p, normalize(vec3(0.3, 1.0, 0.2))) * 11.0 - uTime * 7.0)
                 + sin(dot(p, normalize(vec3(-0.8, -0.2, 0.5))) * 9.0 - uTime * 5.5);
    float disp = wob + ripple * 0.012 * uLevel * uSpeak;
    // Hover: the surface swells gently toward the cursor.
    vec3 dir = normalize(position);
    disp += uHover * 0.07 * pow(max(dot(dir, uPointer), 0.0), 7.0);
    // Click: one soft ripple spreading out from where it landed.
    float ang = acos(clamp(dot(dir, uClickPos), -1.0, 1.0));
    disp += sin(ang * 14.0 - uClickAge * 9.0) * exp(-uClickAge * 2.2) * exp(-ang * 1.2)
          * step(ang, uClickAge * 0.9) * 0.022;
    p += normal * disp;
    p *= uBreath;
    vPos = p;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uListen;
  uniform float uThink;
  uniform float uOpen;
  uniform float uIntensity;
  uniform vec3 uCamObj;
  uniform vec3 uCore;
  uniform vec3 uRimA;
  uniform vec3 uRimB;
  uniform vec3 uTint;
  uniform float uSteps;
  uniform vec3 uPointer;
  uniform float uHover;
  varying vec3 vPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  ${NOISE}

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * snoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v;
  }

  // Rotation about Y by an angle that grows towards the centre: the swirl.
  vec3 swirl(vec3 p, float amt) {
    float a = amt * (1.2 - length(p));
    float c = cos(a), s = sin(a);
    return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  }

  // Rotate v about the unit axis k (Rodrigues).
  vec3 rotAxis(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 3.0);

    // -- the plasma volume, marched from the surface point into the sphere --
    // Start just inside the unit volume: a bulge or a ripple pushes the surface
    // past radius 1, and a march starting out there would stop at once.
    vec3 ro = vPos / max(1.0, length(vPos)) * 0.999;
    vec3 rd = normalize(vPos - uCamObj);
    float speed = 0.18 + uThink * 0.55;
    float swirlAmt = uTime * speed;
    vec3 acc = vec3(0.0);
    float trans = 1.0;
    const int STEPS = 18;
    float stepLen = 2.0 / uSteps;
    for (int i = 0; i < STEPS; i++) {
      if (float(i) >= uSteps) break;
      vec3 p = ro + rd * (float(i) + 0.5) * stepLen;
      float r = length(p);
      if (r > 1.0) break;
      vec3 q = swirl(p, swirlAmt * 2.0);
      // Hover: the plasma eddies around the point under the cursor.
      float near = exp(-length(normalize(p + 1e-4) - uPointer) * 3.0) * uHover;
      q = rotAxis(q, uPointer, near * (1.6 + 0.6 * sin(uTime * 1.3)));
      float n = fbm(q * 1.9 + vec3(0.0, uTime * 0.12, 0.0));
      // Filaments: a ridge of the noise, densest towards the core.
      float fil = 1.0 - abs(n);
      fil = pow(fil, 11.0);
      float core = exp(-r * r * 10.0);
      float d = (fil * 1.5 + core * 0.45) * (1.0 - smoothstep(0.78, 1.0, r));
      d *= 0.9 + uLevel * 0.5 + uListen * 0.25;
      // White-silver at the heart, tinting towards the rim colours outward.
      vec3 col = mix(uCore, mix(uRimA, uRimB, 0.5 + 0.5 * n), smoothstep(0.35, 0.95, r) * 0.35);
      col = mix(col, uRimB, uThink * 0.35 * smoothstep(0.2, 0.9, r));
      float a = d * stepLen * 1.6;
      acc += trans * col * a;
      trans *= exp(-a * 0.9);
    }

    // -- the glass shell --
    // Thin-film sheen: hue follows the viewing angle, kept to the rim.
    vec3 film = 0.5 + 0.5 * cos(6.2831 * (fres * 0.9 + vec3(0.0, 0.33, 0.67) + uTime * 0.03));
    film = mix(film, mix(uRimA, uRimB, fres), 0.55);
    vec3 rim = mix(uRimA, uRimB, 0.5 + 0.5 * sin(uTime * 0.3 + N.y * 2.0)) * fres * (0.85 + uLevel * 0.6);
    // Two soft highlights, a key above-left and a dim fill below-right.
    vec3 L1 = normalize(vec3(-0.5, 0.7, 0.6));
    vec3 L2 = normalize(vec3(0.6, -0.4, 0.5));
    float spec = pow(max(dot(reflect(-L1, N), V), 0.0), 80.0) * 1.3
               + pow(max(dot(reflect(-L2, N), V), 0.0), 40.0) * 0.25;
    // Hover: the rim brightens, most where the cursor is.
    float spot = pow(max(dot(normalize(vPos), uPointer), 0.0), 10.0) * uHover;
    rim *= 1.0 + uHover * 0.45;
    vec3 shell = rim + film * fres * 0.45 + vec3(spec) + mix(uRimA, uCore, 0.5) * spot * 0.35;

    vec3 col = (acc * 0.95 + shell) * uIntensity;
    col = mix(col, col * uTint * 1.3, 0.08);
    col = aces(col * (0.9 + uListen * 0.25));

    // Power-up: grows in from the centre with the reveal.
    float open = smoothstep(0.2, 1.2, uOpen);
    float alpha = clamp(max(max(col.r, col.g), col.b) * 0.9 + fres * 0.3 + (1.0 - trans) * 0.35, 0.0, 1.0) * open;
    gl_FragColor = vec4(col * open, alpha);
  }
`

const haloVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uThink;
  uniform float uScale;
  uniform float uPixelRatio;
  varying float vA;
  void main() {
    vec3 p = position;
    float spin = uTime * (0.08 + aSeed * 0.12) * (1.0 + uThink * 2.0);
    float c = cos(spin), s = sin(spin);
    p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
    vec4 mv = modelViewMatrix * vec4(p * uScale, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = 0.25 + 0.75 * pow(max(0.0, sin(uTime * 1.3 + aSeed * 40.0)), 8.0);
    gl_PointSize = (1.5 + aSeed * 2.5) * uPixelRatio * (6.2 / -mv.z);
  }
`

const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpen;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor * a * vA * 0.55 * uOpen, a * vA * uOpen);
  }
`

/** Sphere radius as a fraction of the shorter viewport side. */
const FIT = 0.22
const HALO = 1400

const CORE = new THREE.Color('#dfe6f5')
const PINK = new THREE.Color('#e88ad0')
const VIOLET = new THREE.Color('#9f8cff')

export function NeutralOrb({ drive }: { drive: Drive }) {
  const group = useRef<THREE.Group>(null)
  const sphere = useRef<THREE.Mesh>(null)
  const viewport = useThree((s) => s.viewport)
  const gl = useThree((s) => s.gl)
  const inv = useMemo(() => ({ m: new THREE.Matrix4(), v: new THREE.Vector3() }), [])
  const perf = useRef({ avg: 1 / 60, since: 0 })
  // The cursor, in window coordinates; the orb works out what it is over each frame.
  const pointer = useRef({ x: 0, y: 0, inside: false, clicked: false, hit: false, spin: 0 })
  const ray = useMemo(() => ({ rc: new THREE.Raycaster(), ndc: new THREE.Vector2(), hit: new THREE.Vector3(), local: new THREE.Vector3() }), [])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = -(e.clientY / window.innerHeight) * 2 + 1
      pointer.current.inside = true
    }
    const leave = () => {
      pointer.current.inside = false
    }
    const down = () => {
      pointer.current.clicked = true
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    document.addEventListener('pointerleave', leave)
    window.addEventListener('blur', leave)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerleave', leave)
      window.removeEventListener('blur', leave)
    }
  }, [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uLevel: { value: 0 },
          uListen: { value: 0 },
          uThink: { value: 0 },
          uSpeak: { value: 0 },
          uOpen: { value: 0 },
          uBreath: { value: 1 },
          uIntensity: { value: 1 },
          uCamObj: { value: new THREE.Vector3(0, 0, 6) },
          uCore: { value: CORE.clone() },
          uRimA: { value: PINK.clone() },
          uRimB: { value: VIOLET.clone() },
          uTint: { value: new THREE.Color('#ffffff') },
          // Volume samples; lowered automatically if the Mac drops below ~55 fps.
          uSteps: { value: 18 },
          uPointer: { value: new THREE.Vector3(0, 0, 1) },
          uHover: { value: 0 },
          uClickPos: { value: new THREE.Vector3(0, 0, 1) },
          uClickAge: { value: 99 },
        },
      }),
    [],
  )

  const halo = useMemo(() => {
    const pos = new Float32Array(HALO * 3)
    const seed = new Float32Array(HALO)
    for (let i = 0; i < HALO; i++) {
      // A loose, slightly flattened shell from 1.15 to 1.9 radii.
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const r = 1.15 + Math.pow(Math.random(), 1.8) * 0.75
      const k = Math.sqrt(1 - u * u)
      pos[i * 3] = Math.cos(t) * k * r
      pos[i * 3 + 1] = u * r * 0.6
      pos[i * 3 + 2] = Math.sin(t) * k * r
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const m = new THREE.ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uThink: { value: 0 },
        uScale: { value: 1 },
        uPixelRatio: { value: 1 },
        uColor: { value: new THREE.Color('#e9dcff') },
        uOpen: { value: 0 },
      },
    })
    return { g, m }
  }, [])

  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 64), [])

  useFrame((frame, dt) => {
    const g = group.current
    const s = sphere.current
    if (!g || !s) return
    const r = drive.reactor
    g.visible = r.visible && r.style === 5
    if (!g.visible) return

    const u = material.uniforms
    const k = (rate: number) => Math.min(1, dt * rate)
    // Hold 60 fps: if frames run slow for two seconds, take fewer volume samples.
    const pf = perf.current
    pf.avg += (Math.min(dt, 0.1) - pf.avg) * 0.05
    pf.since += dt
    if (pf.since > 2 && pf.avg > 1 / 55 && u.uSteps.value > 10) {
      u.uSteps.value -= 2
      pf.since = 0
    }
    const { phase } = useStore.getState()
    const listening = phase === 'listening' || phase === 'waking' ? 1 : 0
    const thinking = phase === 'thinking' || phase === 'tooling' ? 1 : 0
    const speaking = phase === 'speaking' ? 1 : 0

    u.uTime.value += dt * Math.max(0.2, r.spin)
    u.uLevel.value += (drive.level - u.uLevel.value) * k(8)
    u.uListen.value += (listening - u.uListen.value) * k(4)
    u.uThink.value += (thinking - u.uThink.value) * k(2)
    u.uSpeak.value += (speaking - u.uSpeak.value) * k(4)
    u.uOpen.value += (drive.open - u.uOpen.value) * k(1.6)
    u.uIntensity.value = r.intensity
    // Idle breathing, plus a touch of swell with the voice.
    u.uBreath.value = 1 + Math.sin(frame.clock.elapsedTime * 0.9) * 0.012 + u.uLevel.value * 0.03
    // The phase colour only tints; the orb itself stays neutral.
    ;(u.uTint.value as THREE.Color).lerp(r.color, k(2))

    const radius = Math.min(viewport.width, viewport.height) * FIT * r.scale
    g.scale.setScalar(radius)
    // Where is the cursor on the orb? A ray from the camera through it, against the sphere.
    const pt = pointer.current
    let over = false
    if (pt.inside) {
      ray.ndc.set(pt.x, pt.y)
      ray.rc.setFromCamera(ray.ndc, frame.camera)
      const o = ray.rc.ray.origin
      const d = ray.rc.ray.direction
      const b = o.dot(d)
      const disc = b * b - (o.lengthSq() - radius * radius)
      if (disc > 0) {
        const t = -b - Math.sqrt(disc)
        if (t > 0) {
          ray.hit.copy(d).multiplyScalar(t).add(o)
          s.updateWorldMatrix(true, false)
          ray.local.copy(ray.hit)
          s.worldToLocal(ray.local).normalize()
          ;(u.uPointer.value as THREE.Vector3).lerp(ray.local, k(10)).normalize()
          over = true
        }
      }
    }
    u.uHover.value += ((over ? 1 : 0) - u.uHover.value) * k(over ? 6 : 3)
    if (pt.clicked) {
      if (over) {
        ;(u.uClickPos.value as THREE.Vector3).copy(ray.local)
        u.uClickAge.value = 0
      }
      pt.clicked = false
    }
    u.uClickAge.value = Math.min(99, u.uClickAge.value + dt)
    // A gentle tilt toward the cursor, easing back when it leaves.
    pt.spin += dt * 0.05
    const tx = pt.inside ? -pt.y * 0.22 : 0
    const ty = pt.inside ? pt.x * 0.3 : 0
    g.rotation.x += (tx - g.rotation.x) * k(2.5)
    g.rotation.y += (pt.spin + ty - g.rotation.y) * k(2.5)
    // Camera position in the sphere's own space, for the volume raymarch.
    s.updateWorldMatrix(true, false)
    inv.m.copy(s.matrixWorld).invert()
    ;(u.uCamObj.value as THREE.Vector3).copy(inv.v.copy(frame.camera.position).applyMatrix4(inv.m))

    const h = halo.m.uniforms
    h.uTime.value = u.uTime.value
    h.uThink.value = u.uThink.value
    h.uOpen.value = THREE.MathUtils.smoothstep(u.uOpen.value, 0.3, 1.4)
    h.uPixelRatio.value = Math.min(2, gl.getPixelRatio())
  })

  return (
    <group ref={group}>
      <mesh ref={sphere} geometry={geometry} material={material} frustumCulled={false} />
      <points geometry={halo.g} material={halo.m} frustumCulled={false} />
    </group>
  )
}
