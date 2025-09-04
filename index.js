import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ===== Markers / helpers =====
const SPHERE_RADIUS = 20; // must match dot sphere radius

function latLonToVector3(latDeg, lonDeg, radius = SPHERE_RADIUS, altitude = 0) {
  const lat  = THREE.MathUtils.degToRad(latDeg);
  const lon  = THREE.MathUtils.degToRad(lonDeg);
  const phi   = (Math.PI / 2) - lat;   // 90° - lat
  const theta = lon + Math.PI;         // lon + 180°

  const r = radius + altitude;
  const x = -r * Math.sin(phi) * Math.cos(theta);
  const z =  r * Math.sin(phi) * Math.sin(theta);
  const y =  r * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

const textureLoader = new THREE.TextureLoader();
let markersGroup; // created in initScene()

function addFlatMarker({
  lat, lon,
  iconUrl,
  size = 1.2,           // world units
  altitude = 0.15,
  doubleSided = false,
  rollDeg = 0
}) {
  // Build a stable tangent frame at lat/lon (prevents twist)
  const pos     = latLonToVector3(lat, lon, SPHERE_RADIUS, altitude);
  const n       = pos.clone().normalize();                 // outward (surface normal)
  let   upRef   = new THREE.Vector3(0, 1, 0);
  let   east    = new THREE.Vector3().crossVectors(upRef, n);
  if (east.lengthSq() < 1e-6) { upRef.set(0, 0, 1); east.crossVectors(upRef, n); }
  east.normalize();
  const north   = new THREE.Vector3().crossVectors(n, east).normalize();
  const basis   = new THREE.Matrix4().makeBasis(east, north, n);

  // Create plane first, then attach texture when it loads (avoids timing issues)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,       // visible fallback color until texture loads
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide
  });
  const geo = new THREE.PlaneGeometry(1, 1);
  const plane = new THREE.Mesh(geo, mat);

  plane.position.copy(pos);
  plane.setRotationFromMatrix(basis);
  if (rollDeg) plane.rotateOnAxis(n, THREE.MathUtils.degToRad(rollDeg));

  plane.userData.outward  = n;
  plane.userData.baseSize = size;
  plane.userData.aspect   = 1;     // will update after texture load
  plane.scale.set(size, size, 1);  // provisional until we know aspect

  markersGroup.add(plane);

  // Load texture asynchronously and attach it
  textureLoader.load(
    iconUrl,
    (tex) => {
      if (renderer && renderer.capabilities.getMaxAnisotropy) {
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      }
      tex.generateMipmaps = true;
      mat.map = tex;
      mat.color.set(0xffffff); // ensure no tint
      mat.needsUpdate = true;

      const ar = (tex.image && tex.image.width && tex.image.height)
        ? tex.image.width / tex.image.height
        : 1;
      plane.userData.aspect = ar;
      plane.scale.set(size * ar, size, 1);
    },
    undefined,
    (err) => {
      console.error('Marker texture failed to load:', iconUrl, err);
      // keep colored fallback plane visible
    }
  );

  return plane;
}

// Shrink/flatten toward the edges + hide back-side markers
function attenuateMarkerScaleAndVisibility() {
  if (!markersGroup || !baseMesh) return;

  const center = baseMesh.position; // (0,0,0)
  const view   = camera.position.clone().sub(center).normalize();

  const minScale = 0.55; // 0..1 (how small at the edge)

  markersGroup.children.forEach((m) => {
    const normal = m.userData.outward || m.position.clone().sub(center).normalize();
    const dot = normal.dot(view);

    // Hide back side; depthTest also occludes but this is crisp
    m.visible = dot > 0;

    if (m.visible) {
      const t = THREE.MathUtils.clamp(dot, 0, 1);
      const s = THREE.MathUtils.lerp(minScale, 1.0, t);
      const base = m.userData.baseSize || 1;
      const ar   = m.userData.aspect   || 1;
      m.scale.set(base * ar * s, base * s, 1);
    }
  });
}

// ===== Shaders (NO extrusion) =====
const vertex = `
  #ifdef GL_ES
  precision mediump float;
  #endif

  uniform float u_time;

  void main() {
    vec3 newPosition = position; // no extrusion
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const fragment = `
  #ifdef GL_ES
  precision mediump float;
  #endif

  uniform float u_time;
  uniform vec3  u_colorA;
  uniform vec3  u_colorB;

  void main() {
    float pct = abs(sin(u_time));
    vec3 color = mix(u_colorA, u_colorB, pct);
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ===== Scene setup =====
const container = document.querySelector('.container');
const canvas    = document.querySelector('.canvas');

let scene, camera, renderer, controls;
let sizes, raycaster, mouse;
let baseMesh;
let materials = [];
let twinkleTime = 0.027; // set to 0 for completely static dots
let sharedMaterial;

function initScene() {
  sizes = { width: container.offsetWidth, height: container.offsetHeight };

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(30, sizes.width / sizes.height, 1, 1000);
  camera.position.z = window.innerWidth > 700 ? 100 : 140;
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(sizes.width, sizes.height);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = 1.2;
  controls.enableDamping = true;
  controls.enableRotate  = true;
  controls.enablePan     = false;
  controls.enableZoom    = false;
  controls.minPolarAngle = (Math.PI / 2) - 0.5;
  controls.maxPolarAngle = (Math.PI / 2) + 0.5;

  // Picking (optional hover)
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // Base sphere (flat color, no lights needed)
  const baseGeo = new THREE.SphereGeometry(19.5, 35, 35);
  const baseMat = new THREE.MeshBasicMaterial({
    color: 0x132E31,
    transparent: true,
    opacity: 0.9
  });
  baseMesh = new THREE.Mesh(baseGeo, baseMat);
  scene.add(baseMesh);

  // Markers group
  markersGroup = new THREE.Group();
  markersGroup.renderOrder = 2;
  scene.add(markersGroup);

  // Dots material (shader)
  sharedMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      u_time:   { value: 1.0 },
      u_colorA: { value: new THREE.Color('#68D1BF') }, // light
      u_colorB: { value: new THREE.Color('#1D6F78') }, // dark
    },
    vertexShader: vertex,
    fragmentShader: fragment
  });

  // Build globe dots from mask
  buildDotsFromMap();

  // Events
  window.addEventListener('resize', onResize);
  window.addEventListener('mousemove', onMouseMove);

  animate();
}

// ===== Dots builder =====
function buildDotsFromMap() {
  const activeLatLon = {};
  const dotSphereRadius = 20;

  const readImageData = (imageData) => {
    for (let i = 0, lon = -180, lat = 90; i < imageData.length; i += 4, lon++) {
      if (!activeLatLon[lat]) activeLatLon[lat] = [];
      const r = imageData[i], g = imageData[i + 1], b = imageData[i + 2];
      if (r < 80 && g < 80 && b < 80) activeLatLon[lat].push(lon);
      if (lon === 180) { lon = -180; lat--; }
      if (lat < -90) break;
    }
  };

  const visibleAt = (lon, lat) => {
    const row = activeLatLon[lat];
    if (!row || !row.length) return false;
    const closest = row.reduce((p, c) => (Math.abs(c - lon) < Math.abs(p - lon) ? c : p));
    return Math.abs(lon - closest) < 0.5;
  };

  const posFromLatLon = (lon, lat) => {
    const phi   = (90 - lat)  * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const x = -(dotSphereRadius * Math.sin(phi) * Math.cos(theta));
    const z =  (dotSphereRadius * Math.sin(phi) * Math.sin(theta));
    const y =  (dotSphereRadius * Math.cos(phi));
    return new THREE.Vector3(x, y, z);
  };

  const createDotMaterial = (timeSeed) => {
    const m = sharedMaterial.clone();
    m.uniforms.u_time = { value: timeSeed * Math.sin(Math.random()) };
    m.uniforms.u_colorA = sharedMaterial.uniforms.u_colorA;
    m.uniforms.u_colorB = sharedMaterial.uniforms.u_colorB;
    materials.push(m);
    return m;
  };

  const placeDots = () => {
    const dotDensity = 2.5; // lower for performance
    let vec = new THREE.Vector3();

    for (let lat = 90, i = 0; lat > -90; lat--, i++) {
      const radius = Math.cos(Math.abs(lat) * (Math.PI / 180)) * dotSphereRadius;
      const circumference = radius * Math.PI * 2;
      const dotsForLat = Math.max(1, Math.floor(circumference * dotDensity));
      for (let x = 0; x < dotsForLat; x++) {
        const lon = -180 + (x * 360 / dotsForLat);
        if (!visibleAt(lon, lat)) continue;
        vec = posFromLatLon(lon, lat);

        const geo = new THREE.CircleGeometry(0.1, 5);
        geo.lookAt(vec);
        geo.translate(vec.x, vec.y, vec.z);

        const mat = createDotMaterial(i);
        const dot = new THREE.Mesh(geo, mat);
        scene.add(dot);
      }
    }
  };

  const img = new Image();
  // If you load from another domain, uncomment:
  // img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    readImageData(data);
    placeDots();
  };
  img.src = 'img/world_alpha_mini.jpg'; // ensure this path exists
}

// ===== Events =====
function onResize() {
  sizes = { width: container.offsetWidth, height: container.offsetHeight };
  camera.position.z = window.innerWidth > 700 ? 100 : 140;
  camera.aspect = sizes.width / sizes.height;
  camera.updateProjectionMatrix();
  renderer.setSize(sizes.width, sizes.height);
}

function onMouseMove(e) {
  // optional: pointer cursor when hovering base sphere
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObject(baseMesh);
  document.body.style.cursor = hit.length ? 'pointer' : 'default';
}

// ===== Loop =====
function animate() {
  for (const m of materials) m.uniforms.u_time.value += twinkleTime;
  controls.update();

  attenuateMarkerScaleAndVisibility();

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

initScene();

// ===== Markers for your cities =====
const markers = [
  { city: 'London',        lat: 51.5074,  lon:  -0.1278 },
  { city: 'Bengaluru',     lat: 12.9716,  lon:  77.5946 },
  { city: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { city: 'Tokyo',         lat: 35.6762,  lon: 139.6503 },
  { city: 'Nairobi',       lat: -1.2860,  lon:  36.8170 },
  { city: 'Lagos',         lat:  6.5244,  lon:   3.3792 },
  { city: 'São Paulo',     lat: -23.5505, lon: -46.6333 },
  { city: 'New York',      lat: 40.7128,  lon: -74.0060 },
  { city: 'Austin, TX',    lat: 30.2672,  lon: -97.7431 },
  { city: 'San Francisco', lat: 37.7749,  lon: -122.4194 },
  { city: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { city: 'Ho Chi Minh City', lat: 10.8231, lon: 106.6297 },
  { city: 'Helsinki', lat: 60.1699, lon: 24.9384 },
  { city: 'Munich', lat: 48.1351, lon: 11.5820 },
  { city: 'Jakarta', lat: -6.2088, lon: 106.8456 },




];

const defaultMarkerOpts = {
  iconUrl: 'img/antler-icon.png',   // <-- ensure this PNG exists at this path
  size: 1.35,
  altitude: 0.18
};

markers.forEach(({ lat, lon }) => {
  addFlatMarker({ lat, lon, ...defaultMarkerOpts });
});
