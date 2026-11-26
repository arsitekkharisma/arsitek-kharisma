import * as THREE from 'three';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import { OrbitControls } from '/vendor/OrbitControls.js';

const errorOutput = document.getElementById('page-error');
const status = document.getElementById('viewer-status');
const viewer = document.getElementById('model-canvas');
const fallbackImage = document.getElementById('preview-image');
const floorPlan = document.getElementById('floor-plan');
const tokenMatch = /^\/share\/([a-f0-9]{64})\/?$/u.exec(window.location.pathname);
const projectIdMatch = /^\/project\/([a-f0-9-]{36})\/?$/u.exec(window.location.pathname);
const token = tokenMatch?.[1];
const projectId = projectIdMatch?.[1] || new URLSearchParams(window.location.search).get('id');

async function loadProject() {
  if (!token && !projectId) throw new Error('ID proyek atau token tautan tidak ditemukan.');
  const endpoint = token ? `/api/share/${token}` : `/api/projects/${encodeURIComponent(projectId)}`;
  const response = await fetch(endpoint, { credentials: 'same-origin', referrerPolicy: 'no-referrer' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Tautan proyek tidak tersedia.');
  return payload.project || payload;
}

function formatElevation(value) {
  const roundedValue = Math.abs(value) < 0.005 ? 0 : value;
  const prefix = roundedValue === 0 ? '±' : roundedValue < 0 ? '−' : '+';
  return `${prefix}${Math.abs(roundedValue).toFixed(2)} m`;
}

function setupViewer(modelUrl, bounds, onCutInput) {
  if (!bounds || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.maxY)) {
    throw new Error('Batas ketinggian model tidak tersedia.');
  }

  const sectionSlider = document.getElementById('section-slider');
  const sectionHeight = document.getElementById('section-height');
  const fullModelButton = document.getElementById('show-full-model');
  const modelCenterY = (bounds.minY + bounds.maxY) / 2;
  const minCut = bounds.minY - modelCenterY;
  const maxCut = bounds.maxY - modelCenterY;
  const cutRange = Math.max(maxCut - minCut, 0.01);
  const cutStep = Math.max(cutRange / 1000, 0.01);
  const clampCut = value => Math.max(minCut, Math.min(maxCut, value));
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), maxCut);
  let targetCut = maxCut;
  let currentCut = maxCut;

  sectionSlider.min = String(minCut);
  sectionSlider.max = String(maxCut);
  sectionSlider.step = String(cutStep);
  sectionSlider.value = String(maxCut);

  function setCut(value) {
    targetCut = clampCut(value);
    sectionSlider.value = String(targetCut);
    const height = modelCenterY + targetCut;
    sectionHeight.textContent = `${height.toFixed(2)} m`;
    status.textContent = Math.abs(targetCut - maxCut) < 0.001
      ? 'Model utuh · gulir untuk melihat potongan'
      : `Potongan pada ${height.toFixed(2)} m`;
  }

  sectionSlider.addEventListener('input', () => onCutInput(Number(sectionSlider.value)));
  fullModelButton.addEventListener('click', () => onCutInput(maxCut));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (error) {
    status.textContent = `Pratinjau 3D tidak tersedia: ${error.message}`;
    fallbackImage.style.display = 'block';
    sectionSlider.disabled = true;
    fullModelButton.disabled = true;
    return { minCut, maxCut, cutRange, modelCenterY, setCut };
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#efeee9');
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewer.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x77736a, 1.8));
  const keyLight = new THREE.DirectionalLight(0xfff9f0, 2);
  keyLight.position.set(1, 2, 1);
  keyLight.castShadow = true;
  scene.add(keyLight);

  let modelSpan = Math.max(bounds.maxY - bounds.minY, 1);
  function resize() {
    const width = Math.max(1, viewer.clientWidth);
    const height = Math.max(1, viewer.clientHeight);
    const aspect = width / height;
    const frustumHeight = modelSpan * 1.55;
    camera.left = -frustumHeight * aspect / 2;
    camera.right = frustumHeight * aspect / 2;
    camera.top = frustumHeight / 2;
    camera.bottom = -frustumHeight / 2;
    camera.position.set(modelSpan * 1.45, modelSpan * 1.25, modelSpan * 1.6);
    camera.lookAt(0, 0, 0);
    camera.far = modelSpan * 100;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  new ResizeObserver(resize).observe(viewer);
  resize();
  setCut(maxCut);

  new GLTFLoader().load(modelUrl, gltf => {
    const model = gltf.scene;
    scene.add(model);
    const modelBounds = new THREE.Box3().setFromObject(model);
    const size = modelBounds.getSize(new THREE.Vector3());
    const center = modelBounds.getCenter(new THREE.Vector3());
    modelSpan = Math.max(size.x, size.y, size.z, 0.1);
    model.position.sub(center);
    model.traverse(object => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => {
        material.clippingPlanes = [...(material.clippingPlanes || []), sectionPlane];
        material.needsUpdate = true;
      });
    });
    resize();
    controls.target.set(0, 0, 0);
    controls.update();
    fallbackImage.style.display = 'none';
    status.textContent = 'Model utuh · gulir untuk melihat potongan';
  }, undefined, error => {
    status.textContent = `Model 3D tidak dapat dimuat: ${error.message}`;
    fallbackImage.style.display = 'block';
    sectionSlider.disabled = true;
    fullModelButton.disabled = true;
  });

  function animate() {
    requestAnimationFrame(animate);
    currentCut += (targetCut - currentCut) * 0.14;
    sectionPlane.constant = currentCut;
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return { minCut, maxCut, cutRange, modelCenterY, setCut };
}

function renderProject(project) {
  document.title = `${project.title} · Pratinjau Proyek`;
  document.getElementById('project-title').textContent = project.title;
  document.getElementById('project-description').textContent = project.description || '';
  document.getElementById('project-location').textContent = project.location || '—';
  document.getElementById('tb-project').textContent = project.title;

  const dimensions = project.metadata.dimensions;
  document.getElementById('project-dimensions').textContent =
    `${dimensions.width.toFixed(2)} × ${dimensions.depth.toFixed(2)} × ${dimensions.height.toFixed(2)} m`;
  document.getElementById('project-floor-count').textContent = String(project.metadata.floorCount);
  document.getElementById('project-north').textContent = `${project.metadata.northDegrees.toFixed(1)}° dari utara model`;
  document.getElementById('download-model').href = project.modelUrl;
  fallbackImage.src = project.previewUrl;
  floorPlan.src = project.previewUrl;
  floorPlan.alt = `Aksonometri ${project.title}`;

  const scrollTrack = document.getElementById('scroll-track');
  const floorList = document.getElementById('floor-list');
  const scrollMarker = document.getElementById('scroll-marker');
  const cutLiveTag = document.getElementById('cut-live-tag');
  const bounds = project.metadata.bounds;
  const minY = bounds.minY;
  const maxY = bounds.maxY;
  const heightRange = Math.max(maxY - minY, 0.01);
  const scrollFloors = [...project.floors]
    .sort((a, b) => b.elevation - a.elevation)
    .map(floor => ({
      ...floor,
      progress: Math.max(0, Math.min(1, (maxY - floor.elevation) / heightRange))
    }));

  scrollTrack.style.height = `${Math.max(3, scrollFloors.length + 1) * 100}vh`;
  scrollFloors.forEach(floor => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'level-btn';
    button.style.top = `${4 + floor.progress * 92}%`;
    button.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.textContent = floor.title;
    const elevation = document.createElement('span');
    elevation.textContent = formatElevation(floor.elevation).replace(' m', '');
    button.append(label, elevation);
    button.addEventListener('click', () => scrollToProgress(floor.progress));
    floorList.append(button);
    floor.button = button;
  });

  const planTitle = document.getElementById('plan-title');
  const planLevel = document.getElementById('plan-level');
  const drawingOutput = document.getElementById('tb-drawing');
  const floorOutput = document.getElementById('tb-floor');
  const cutOutput = document.getElementById('tb-cut');
  const sheetOutput = document.getElementById('tb-sheet');
  let activePlanIndex = -2;
  let viewerController;

  function scrollToProgress(progress) {
    const scrollDistance = Math.max(0, scrollTrack.offsetHeight - window.innerHeight);
    const trackTop = window.scrollY + scrollTrack.getBoundingClientRect().top;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.scrollTo({ top: trackTop + scrollDistance * progress, behavior });
  }

  function updatePlan(progress) {
    let selectedIndex = -1;
    if (scrollFloors.length && progress >= scrollFloors[0].progress / 2) {
      selectedIndex = 0;
      for (let index = 0; index < scrollFloors.length - 1; index += 1) {
        const boundary = (scrollFloors[index].progress + scrollFloors[index + 1].progress) / 2;
        if (progress >= boundary) selectedIndex = index + 1;
        else break;
      }
    }

    if (selectedIndex === activePlanIndex) return;
    activePlanIndex = selectedIndex;
    scrollFloors.forEach((floor, index) => {
      floor.button.classList.toggle('active', index === selectedIndex);
      floor.button.setAttribute('aria-pressed', String(index === selectedIndex));
    });

    if (selectedIndex < 0) {
      planTitle.textContent = 'AKSONOMETRI';
      planLevel.textContent = 'MODEL UTUH';
      floorPlan.src = project.previewUrl;
      floorPlan.alt = `Aksonometri ${project.title}`;
      drawingOutput.textContent = 'Aksonometri';
      floorOutput.textContent = '—';
      sheetOutput.textContent = 'A-001';
      return;
    }

    const floor = scrollFloors[selectedIndex];
    planTitle.textContent = `DENAH ${floor.title}`.toLocaleUpperCase('id-ID');
    planLevel.textContent = formatElevation(floor.elevation).toLocaleUpperCase('id-ID');
    floorPlan.src = floor.planUrl;
    floorPlan.alt = `Denah ${floor.title}`;
    drawingOutput.textContent = 'Denah';
    floorOutput.textContent = floor.title;
    sheetOutput.textContent = `D-${String(floor.index + 1).padStart(3, '0')}`;
  }

  function updateProgress(progress) {
    const normalized = Math.max(0, Math.min(1, progress));
    const cut = viewerController.maxCut - normalized * (viewerController.maxCut - viewerController.minCut);
    const elevation = maxY - normalized * heightRange;
    viewerController.setCut(cut);
    scrollMarker.style.top = `${4 + normalized * 92}%`;
    cutLiveTag.style.top = `${4 + normalized * 92}%`;
    cutLiveTag.textContent = `POTONGAN ${formatElevation(elevation)}`;
    cutOutput.textContent = formatElevation(elevation);
    updatePlan(normalized);
  }

  function updateFromScroll() {
    const scrollDistance = scrollTrack.offsetHeight - window.innerHeight;
    const progress = scrollDistance > 0
      ? Math.max(0, Math.min(1, -scrollTrack.getBoundingClientRect().top / scrollDistance))
      : 0;
    updateProgress(progress);
  }

  function updateFromSlider(cut) {
    const progress = Math.max(0, Math.min(1,
      (viewerController.maxCut - cut) / (viewerController.maxCut - viewerController.minCut)));
    updateProgress(progress);
    scrollToProgress(progress);
  }

  viewerController = setupViewer(project.modelUrl, bounds, updateFromSlider);
  window.addEventListener('scroll', updateFromScroll, { passive: true });
  window.addEventListener('resize', updateFromScroll);
  updateFromScroll();
}

loadProject()
  .then(renderProject)
  .catch(error => {
    errorOutput.textContent = error.message;
    status.textContent = 'Model tidak tersedia.';
  });
