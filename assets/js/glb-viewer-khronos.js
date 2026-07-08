import {
  GltfView,
  GltfState,
  ResourceLoader
} from '../vendor/khronos-gltf-sample-renderer/gltf-viewer.module.js';

(function () {
  var canvas = document.getElementById('glb-viewer');
  if (!canvas) return;

  var src = canvas.getAttribute('data-src');
  if (!src) return;

  var hdrSrc = canvas.getAttribute('data-hdr-src');
  var renderEnvMapAttr = canvas.getAttribute('data-render-env-map');
  var renderEnvMap = renderEnvMapAttr === 'true';
  var lutSheenESrc = canvas.getAttribute('data-lut-sheen-e-src') ||
    '/assets/vendor/khronos-gltf-sample-renderer/assets/lut_sheen_E.png';
  var supersampleFactor = parseFloat(canvas.getAttribute('data-supersample-factor') || '2');
  if (!isFinite(supersampleFactor) || supersampleFactor < 1) supersampleFactor = 1;
  var pivotOffset = (canvas.getAttribute('data-pivot-offset') || '')
    .split(',')
    .map(function (value) { return parseFloat(value); })
    .filter(function (value) { return isFinite(value); });
  if (pivotOffset.length !== 3) pivotOffset = [0, 0, 0];

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var darkMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  var visible = false;
  var loaded = false;
  var loading = false;
  var rafId = null;
  var lastTs = 0;
  var idleT = 0;
  var userTouched = false;
  var dragging = false;
  var lastX = 0;
  var lastY = 0;
  var pinch0 = 0;
  var idleLast = 0;
  var status = document.createElement('p');
  status.className = 'asset-credit glbviewer-status';
  status.setAttribute('aria-live', 'polite');
  canvas.insertAdjacentElement('afterend', status);

  function setStatus(message) {
    canvas.setAttribute('data-status', message);
    status.textContent = message || '';
  }

  function clearStatus() {
    canvas.removeAttribute('data-status');
    status.textContent = '';
  }

  function applyPivotOffset(gltf, sceneIndex) {
    if (!gltf || pivotOffset[0] === 0 && pivotOffset[1] === 0 && pivotOffset[2] === 0) return;
    var scene = gltf.scenes && gltf.scenes[sceneIndex];
    if (!scene || !scene.nodes) return;

    scene.nodes.forEach(function (nodeIndex) {
      var node = gltf.nodes && gltf.nodes[nodeIndex];
      if (!node || !node.translation) return;
      node.translation = [
        node.translation[0] + pivotOffset[0],
        node.translation[1] + pivotOffset[1],
        node.translation[2] + pivotOffset[2]
      ];
    });
  }

  var gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) {
    canvas.classList.add('glbviewer-error');
    setStatus('WebGL2 no disponible');
    return;
  }

  var view = new GltfView(gl);
  var state = view.createState();
  var libPath = canvas.getAttribute('data-khronos-lib-path') ||
    '../vendor/khronos-gltf-sample-renderer/libs/';
  var loader = new ResourceLoader(view, libPath);

  state.renderingParameters.useIBL = false;
  state.renderingParameters.renderEnvironmentMap = false;
  state.renderingParameters.blurEnvironmentMap = false;
  state.renderingParameters.useDirectionalLightsWithDisabledIBL = true;
  state.renderingParameters.toneMap = GltfState.ToneMaps.KHR_PBR_NEUTRAL;

  function applyTheme() {
    var dark = darkMq && darkMq.matches;
    state.renderingParameters.clearColor = dark ? [0.051, 0.051, 0.051, 1] : [1, 1, 1, 1];
    requestFrame();
  }

  applyTheme();
  if (darkMq && darkMq.addEventListener) {
    darkMq.addEventListener('change', applyTheme);
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * supersampleFactor;
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (state.userCamera && state.userCamera.perspective) {
        state.userCamera.perspective.aspectRatio = w / h;
        if (loaded) state.userCamera.fitViewToScene(state.gltf, state.sceneIndex);
      }
    }
  }

  function requestFrame() {
    if (rafId === null && visible && loaded) {
      lastTs = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(ts) {
    rafId = null;
    var dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    resize();

    if (!userTouched && !reduce) {
      idleT += dt;
      var idleNow = Math.sin(idleT * 0.65) * 28;
      state.userCamera.orbit(idleNow - idleLast, 0);
      idleLast = idleNow;
    }

    try {
      view.renderFrame(state, canvas.width, canvas.height);
    } catch (err) {
      console.error('glb-viewer-khronos render:', err);
      canvas.classList.add('glbviewer-error');
      setStatus('Error renderizando con Khronos glTF Sample Renderer; revisa la consola.');
      return;
    }

    if ((!userTouched && !reduce) || dragging) {
      rafId = requestAnimationFrame(frame);
    }
  }

  async function load() {
    if (loading || loaded) return;
    loading = true;
    canvas.classList.add('glbviewer-loading');
    setStatus(hdrSrc ? 'Cargando modelo e HDR' : 'Cargando modelo');

    var environmentPromise = hdrSrc
      ? loader.loadEnvironment(hdrSrc, { lut_sheen_E_file: lutSheenESrc }).catch(function (err) {
          console.warn('glb-viewer-khronos HDR:', err);
          return undefined;
        })
      : Promise.resolve(undefined);

    try {
      state.gltf = await loader.loadGltf(src);
      state.sceneIndex = 0;
      applyPivotOffset(state.gltf, state.sceneIndex);

      state.environment = await environmentPromise;
      if (state.environment !== undefined) {
        state.renderingParameters.useIBL = true;
        state.renderingParameters.renderEnvironmentMap = renderEnvMap;
        state.renderingParameters.blurEnvironmentMap = renderEnvMap;
      }

      resize();
      state.userCamera.resetView(state.gltf, state.sceneIndex);
      state.userCamera.orbit(-35, -8);
      state.userCamera.setDistanceFromTarget(
        Math.max(0.1, state.userCamera.distance - 3),
        state.userCamera.getTarget()
      );
      loaded = true;
      canvas.classList.remove('glbviewer-loading');
      clearStatus();
      requestFrame();
    } catch (err) {
      console.error('glb-viewer-khronos:', err);
      canvas.classList.remove('glbviewer-loading');
      canvas.classList.add('glbviewer-error');
      setStatus('No se pudo cargar el modelo con Khronos glTF Sample Renderer; revisa la consola.');
    }
  }

  function onDown(x, y) {
    dragging = true;
    userTouched = true;
    lastX = x;
    lastY = y;
  }

  function onMove(x, y) {
    if (!dragging || !loaded) return;
    state.userCamera.orbit(x - lastX, y - lastY);
    lastX = x;
    lastY = y;
    requestFrame();
  }

  function touchGap(e) {
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  canvas.addEventListener('mousedown', function (e) {
    onDown(e.clientX, e.clientY);
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { dragging = false; });
  canvas.addEventListener('wheel', function (e) {
    if (!loaded) return;
    e.preventDefault();
    userTouched = true;
    state.userCamera.zoomBy(e.deltaY > 0 ? 1 : -1);
    requestFrame();
  }, { passive: false });
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      onDown(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      dragging = false;
      userTouched = true;
      pinch0 = touchGap(e);
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!loaded) return;
    if (e.touches.length === 2 && pinch0 > 0) {
      var gap = Math.max(1, touchGap(e));
      state.userCamera.zoomBy(gap > pinch0 ? -0.8 : 0.8);
      pinch0 = gap;
      requestFrame();
      e.preventDefault();
    } else if (e.touches.length === 1 && dragging) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener('touchend', function () {
    dragging = false;
    pinch0 = 0;
  });

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) {
        load();
        requestFrame();
      } else if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }, { rootMargin: '400px' });
    io.observe(canvas);
  } else {
    visible = true;
    load();
  }

  window.addEventListener('resize', requestFrame);
})();
