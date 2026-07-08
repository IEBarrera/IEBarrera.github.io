/* ---------------------------------------------------------------
   Visor GLB (glTF binario, WebGL, sin dependencias) — ejemplo del
   post de moiréGL.

   Parsea el .glb directamente: chunk JSON + chunk binario, escena
   por defecto con transformaciones de nodo (TRS o matriz), un draw
   indexado por primitiva y materiales PBR (baseColor, metallic,
   roughness). La iluminación es IBL sobre el HDR del entorno
   (golden_gate_hills), horneado a mapas RGBM equirect por
   tools/bake_env.py: irradiancia difusa + atlas especular
   prefiltrado por rugosidad, con BRDF split-sum y tono ACES. El alfa
   se resuelve como cutout con el alphaCutoff del material:
   independiente del orden de dibujo, no necesita sorting al rotar. Un
   pequeño término de luz en el color del tema mantiene visible el
   modelo sobre fondo oscuro.

   - El .glb se descarga recién cuando el canvas se acerca al
     viewport (IntersectionObserver): pesa varios MB.
   - Arrastrar (mouse o touch) rota el modelo; sin interacción,
     oscila solo en un vaivén suave (se respeta reduced-motion).
   - El rAF se pausa cuando el canvas sale de pantalla.
   --------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('glb-viewer');
  if (!canvas) return;

  var SRC = canvas.getAttribute('data-src');
  if (!SRC) return;

  var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) { canvas.style.display = 'none'; return; }
  // mallas de >65k vértices: índices de 32 bits (soporte universal en WebGL1)
  gl.getExtension('OES_element_index_uint');

  var VERT = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec2 aUV;',
    'uniform mat4 uMVP;',
    'uniform mat3 uNormalMat;',
    'varying vec3 vNormal;',
    'varying vec2 vUV;',
    'void main(){',
    '  vNormal = uNormalMat * aNormal;',
    '  vUV = aUV;',
    '  gl_Position = uMVP * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'varying vec3 vNormal;',
    'varying vec2 vUV;',
    'uniform vec3 u_line;',      // color de línea del tema (luz de relleno)
    'uniform vec4 uBaseColor;',  // baseColorFactor del material
    'uniform bool uUseTex;',
    'uniform float uCutoff;',    // alphaCutoff; 0 = opaco (alfa ignorado)
    'uniform sampler2D uTex;',
    'uniform bool uUseMR;',
    'uniform sampler2D uMRTex;',
    'uniform bool uHasEnv;',     // mapas de entorno (del EXR, preprocesados)
    'uniform sampler2D uEnvSpec;',  // atlas RGBM de 8 niveles de rugosidad
    'uniform sampler2D uEnvDiff;',  // irradiancia difusa RGBM
    'uniform float uMetal;',     // metallicFactor del material
    'uniform float uRough;',     // roughnessFactor del material
    // --- entorno HDR ---
    // Los PNG del entorno guardan valores HDR en RGBM (rgb * a*ENV_MAX): así
    // el sol y los brillos superan 1.0 en vez de clampearse. ENV_MAX y el
    // número de niveles/altura de banda deben coincidir con tools/bake_env.py.
    '#define ENV_MAX 16.0',
    '#define ENV_LEVELS 8.0',
    '#define ENV_BAND 256.0',      // alto en px de cada nivel del atlas
    '#define EXPOSURE 0.7',
    'vec3 decodeRGBM(vec4 c){ return c.rgb * (c.a * ENV_MAX); }',
    // dirección -> UV equirectangular (+Y arriba; +1.0 = entorno girado 180°)
    'vec2 dirUV(vec3 d){',
    '  d = normalize(d);',
    '  return vec2(atan(d.z, d.x) * 0.15915494 + 1.0,',
    '              acos(clamp(d.y, -1.0, 1.0)) * 0.31830989);',
    '}',
    // un nivel del atlas especular: v de banda acotado a medio texel para que
    // el filtrado bilineal no sangre hacia el nivel vecino
    'vec3 specLevel(vec3 dir, float lvl){',
    '  vec2 uv = dirUV(dir);',
    '  float v = clamp(uv.y, 0.5 / ENV_BAND, 1.0 - 0.5 / ENV_BAND);',
    '  return decodeRGBM(texture2D(uEnvSpec, vec2(uv.x, (lvl + v) / ENV_LEVELS)));',
    '}',
    // reflejo prefiltrado: la rugosidad elige el nivel (LOD trilineal manual)
    'vec3 envSpec(vec3 dir, float rough){',
    '  float lf = rough * (ENV_LEVELS - 1.0);',
    '  float l0 = floor(lf);',
    '  return mix(specLevel(dir, l0),',
    '             specLevel(dir, min(l0 + 1.0, ENV_LEVELS - 1.0)), lf - l0);',
    '}',
    // aproximación analítica del BRDF ambiental (Karis, "PBR on Mobile"):
    // devuelve (escala, sesgo) para F0 según rugosidad y ángulo de vista
    'vec2 envBRDF(float NoV, float rough){',
    '  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);',
    '  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);',
    '  vec4 r = rough * c0 + c1;',
    '  float a = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;',
    '  return vec2(-1.04, 1.04) * a + r.zw;',
    '}',
    // ACES filmic (aprox. de Narkowicz): comprime el rango HDR a pantalla
    'vec3 aces(vec3 x){',
    '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),',
    '               0.0, 1.0);',
    '}',
    'void main(){',
    // vista en +z (espacio de vista); normal orientada hacia el observador
    // porque las placas son de doble cara
    '  vec3 n = normalize(vNormal);',
    '  if (n.z < 0.0) n = -n;',
    '  vec3 l = normalize(vec3(0.0, 0.9, 0.45));',
    '  float diff = 0.35 + 0.65 * max(dot(n, l), 0.0);',
    // pipeline lineal: los factores glTF ya son lineales; las texturas
    // baseColor vienen en sRGB y se decodifican antes de iluminar
    '  vec4 base = uBaseColor;',
    '  if (uUseTex) {',
    '    vec4 tx = texture2D(uTex, vUV);',
    '    tx.rgb = pow(tx.rgb, vec3(2.2));',
    '    base *= tx;',
    '  }',
    // cutout: el alfa recorta la capa (independiente del orden de dibujo)
    '  if (uCutoff > 0.0 && base.a < uCutoff) discard;',
    '  float rough = clamp(uRough, 0.0, 1.0);',
    '  float metal = clamp(uMetal, 0.0, 1.0);',
    '  if (uUseMR) {',
    '    vec4 mr = texture2D(uMRTex, vUV);',
    '    rough *= mr.g;',
    '    metal *= mr.b;',
    '  }',
    '  float specRough = clamp(rough * rough, 0.04, 1.0);',
    '  vec3 col;',
    '  if (uHasEnv) {',
    // IBL split-sum: difuso (irradiancia) + especular (entorno prefiltrado)
    '    float NoV = clamp(abs(n.z), 0.0, 1.0);',
    '    vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);',
    '    vec3 F0 = mix(vec3(0.04), base.rgb, metal);',
    '    vec3 irr = decodeRGBM(texture2D(uEnvDiff, dirUV(n)));',
    '    vec3 diffuse = base.rgb * (1.0 - metal) * irr;',
    '    vec2 ab = envBRDF(NoV, specRough);',
    '    vec3 specular = envSpec(R, specRough) * (F0 * ab.x + ab.y);',
    '    col = diffuse + specular;',
    '  } else {',
    '    col = base.rgb * diff;',
    '  }',
    '  col *= EXPOSURE;',
    '  col = aces(col);',                   // tono HDR -> LDR
    '  col = pow(col, vec3(1.0 / 2.2));',   // lineal -> sRGB
    // relleno en el color del tema: un base negro sigue leyéndose en oscuro
    '  col += u_line * 0.06 * diff;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  var uMVP    = gl.getUniformLocation(prog, 'uMVP');
  var uNormal = gl.getUniformLocation(prog, 'uNormalMat');
  var uLine   = gl.getUniformLocation(prog, 'u_line');
  var uBase   = gl.getUniformLocation(prog, 'uBaseColor');
  var uUseTex = gl.getUniformLocation(prog, 'uUseTex');
  var uCutoff = gl.getUniformLocation(prog, 'uCutoff');
  var uTex    = gl.getUniformLocation(prog, 'uTex');
  var uUseMR  = gl.getUniformLocation(prog, 'uUseMR');
  var uMRTex  = gl.getUniformLocation(prog, 'uMRTex');
  var uHasEnv = gl.getUniformLocation(prog, 'uHasEnv');
  var uMetal  = gl.getUniformLocation(prog, 'uMetal');
  var uRough  = gl.getUniformLocation(prog, 'uRough');
  gl.uniform1i(uTex, 0);
  gl.uniform1i(uMRTex, 3);
  gl.uniform1i(gl.getUniformLocation(prog, 'uEnvSpec'), 1);
  gl.uniform1i(gl.getUniformLocation(prog, 'uEnvDiff'), 2);

  var aPos = gl.getAttribLocation(prog, 'aPos');
  var aNrm = gl.getAttribLocation(prog, 'aNormal');
  var aUV  = gl.getAttribLocation(prog, 'aUV');
  gl.enableVertexAttribArray(aPos);
  gl.enableVertexAttribArray(aNrm);
  gl.enableVertexAttribArray(aUV);

  // Colores según el tema (los mismos --bg / --line del CSS).
  var clearCol = [1, 1, 1];
  var darkMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    if (darkMq && darkMq.matches) {
      clearCol = [0.051, 0.051, 0.051];              // #0d0d0d
      gl.uniform3f(uLine, 0.941, 0.941, 0.941);      // #f0f0f0
    } else {
      clearCol = [1.0, 1.0, 1.0];                    // #ffffff
      gl.uniform3f(uLine, 0.067, 0.067, 0.067);      // #111111
    }
  }
  applyTheme();
  if (darkMq && darkMq.addEventListener) {
    darkMq.addEventListener('change', function () { applyTheme(); requestFrame(); });
  }

  /* --- Matrices 4x4 mínimas (column-major) --- */
  function perspective(fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0,
            0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                     a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function rotX(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  }
  function rotY(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  }
  var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // T * R * S de un nodo glTF (o su matriz explícita)
  function nodeMatrix(node) {
    if (node.matrix) return node.matrix;
    var q = node.rotation || [0, 0, 0, 1];
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var m = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w),     2 * (x * z - y * w),     0,
      2 * (x * y - z * w),     1 - 2 * (x * x + z * z), 2 * (y * z + x * w),     0,
      2 * (x * z + y * w),     2 * (y * z - x * w),     1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1
    ];
    var s = node.scale || [1, 1, 1];
    for (var i = 0; i < 3; i++) {
      m[i] *= s[0]; m[4 + i] *= s[1]; m[8 + i] *= s[2];
    }
    var t = node.translation || [0, 0, 0];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
  }

  // Matriz normal: inversa-transpuesta del 3x3 superior (cofactores / det),
  // necesaria porque hay nodos con escala no uniforme.
  function normalMat3(m) {
    var a00 = m[0], a01 = m[4], a02 = m[8];
    var a10 = m[1], a11 = m[5], a12 = m[9];
    var a20 = m[2], a21 = m[6], a22 = m[10];
    var k00 = a11 * a22 - a12 * a21;
    var k01 = a12 * a20 - a10 * a22;
    var k02 = a10 * a21 - a11 * a20;
    var k10 = a02 * a21 - a01 * a22;
    var k11 = a00 * a22 - a02 * a20;
    var k12 = a01 * a20 - a00 * a21;
    var k20 = a01 * a12 - a02 * a11;
    var k21 = a02 * a10 - a00 * a12;
    var k22 = a00 * a11 - a01 * a10;
    var det = a00 * k00 + a01 * k01 + a02 * k02;
    var d = det !== 0 ? 1 / det : 1;
    // N[r][c] = cofactor(a[r][c]) / det
    return [k00 * d, k01 * d, k02 * d,
            k10 * d, k11 * d, k12 * d,
            k20 * d, k21 * d, k22 * d];
  }

  /* --- Lectura de accessors del chunk binario --- */
  var COMP_ARRAY = {
    5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
    5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
  };
  var COMP_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  var COMP_NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

  function readAccessor(json, buf, binOffset, idx) {
    var acc = json.accessors[idx];
    var bv = json.bufferViews[acc.bufferView];
    var Arr = COMP_ARRAY[acc.componentType];
    var n = COMP_COUNT[acc.type];
    var offset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    var tight = n * Arr.BYTES_PER_ELEMENT;
    var stride = bv.byteStride || tight;
    var out = new Arr(acc.count * n);
    if (stride === tight) {
      out.set(new Arr(buf, offset, acc.count * n));
    } else {
      for (var i = 0; i < acc.count; i++) {
        var v = new Arr(buf, offset + i * stride, n);
        for (var c = 0; c < n; c++) out[i * n + c] = v[c];
      }
    }
    if (acc.normalized && COMP_NORM[acc.componentType]) {
      var f = new Float32Array(out.length);
      var max = COMP_NORM[acc.componentType];
      for (var j = 0; j < out.length; j++) f[j] = Math.max(out[j] / max, -1);
      return f;
    }
    return out;
  }

  /* --- Estado --- */
  var groups = [];                 // {vbo, ibo, count, idxType, mat}
  var materials = [];              // {color:[r,g,b,a], cutoff, texIndex, tex, mrIndex, mr}
  var normMat = IDENT;             // centra y escala el modelo a radio ~1
  var loaded = false, loading = false;
  var yaw = 0, pitch = 0;          // rotación del usuario
  var dist = 3.0;                  // distancia de cámara (zoom)
  var idleT = 0;                   // fase del vaivén automático
  var userTouched = false;

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- Mapas de entorno (equirect HDR en RGBM, preprocesados desde el EXR) --- */
  var envCount = 0;
  function loadEnvMap(url, unit) {
    var img = new Image();
    img.onload = function () {
      gl.activeTexture(gl.TEXTURE0 + unit);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      // REPEAT horizontal: la costura del atan() cae en u = 0/1
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // sin mipmaps: promediar texels RGBM no es lineal (daría halos); el
      // desenfoque por rugosidad ya viene horneado en los niveles del atlas
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.activeTexture(gl.TEXTURE0);       // el resto del código usa la unidad 0
      envCount++;
      requestFrame();
    };
    img.onerror = function () {
      console.warn('glb-viewer: no se pudo cargar el mapa de entorno', url);
    };
    img.src = url;
  }
  var ENV_SPEC = canvas.getAttribute('data-env-spec');
  var ENV_DIFF = canvas.getAttribute('data-env-diff');
  if (ENV_SPEC && ENV_DIFF) {
    loadEnvMap(ENV_SPEC, 1);
    loadEnvMap(ENV_DIFF, 2);
  }

  /* --- Texturas embebidas: bufferView -> Blob -> Image --- */
  function loadTexture(json, buf, binOffset, mat, kind) {
    var texIndex = kind === 'mr' ? mat.mrIndex : mat.texIndex;
    var texDef = json.textures[texIndex];
    var imgDef = json.images[texDef.source];
    var sampler = texDef.sampler !== undefined ? json.samplers[texDef.sampler] : {};
    var bv = json.bufferViews[imgDef.bufferView];
    var blob = new Blob(
      [new Uint8Array(buf, binOffset + (bv.byteOffset || 0), bv.byteLength)],
      { type: imgDef.mimeType }
    );
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      // Reescala a potencia de dos: WebGL1 solo mipmapea (y repite) POT, y
      // sin mipmaps una textura de franjas finas brilla con aliasing.
      var src = img;
      if ((img.width & (img.width - 1)) || (img.height & (img.height - 1))) {
        var c = document.createElement('canvas');
        c.width = c.height = 2048;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        src = c;
      }
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // glTF: origen UV arriba-izquierda, igual que la imagen — sin flip
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, sampler.wrapS || gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, sampler.wrapT || gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        var maxA = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxA));
      }
      if (kind === 'mr') mat.mr = tex;
      else mat.tex = tex;
      requestFrame();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      console.warn('glb-viewer: no se pudo decodificar la textura', texIndex);
    };
    img.src = url;
  }

  /* --- Construcción de la escena --- */
  function buildScene(json, buf, binOffset) {
    var bboxMin = [Infinity, Infinity, Infinity];
    var bboxMax = [-Infinity, -Infinity, -Infinity];

    // materiales: solo baseColor (factor + textura) y modo de alfa
    var mats = json.materials || [];
    for (var m = 0; m < mats.length; m++) {
      var pbr = mats[m].pbrMetallicRoughness || {};
      var mode = mats[m].alphaMode || 'OPAQUE';
      materials.push({
        color: pbr.baseColorFactor || [1, 1, 1, 1],
        // BLEND también sale como cutout: evita el sorting al rotar
        cutoff: mode === 'OPAQUE' ? 0 :
                (mode === 'MASK' ? (mats[m].alphaCutoff !== undefined ? mats[m].alphaCutoff : 0.5) : 0.5),
        metal: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
        rough: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
        texIndex: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1,
        mrIndex: pbr.metallicRoughnessTexture ? pbr.metallicRoughnessTexture.index : -1,
        tex: null
      });
    }

    function addPrimitive(prim, world) {
      if (prim.mode !== undefined && prim.mode !== 4) return;  // solo TRIANGLES
      var pos = readAccessor(json, buf, binOffset, prim.attributes.POSITION);
      var nrm = prim.attributes.NORMAL !== undefined ?
        readAccessor(json, buf, binOffset, prim.attributes.NORMAL) : null;
      var uv = prim.attributes.TEXCOORD_0 !== undefined ?
        readAccessor(json, buf, binOffset, prim.attributes.TEXCOORD_0) : null;
      var nm = normalMat3(world);

      // interleave con la transformación del nodo ya aplicada
      var count = pos.length / 3;
      var data = new Float32Array(count * 8);
      for (var i = 0; i < count; i++) {
        var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        var wx = world[0] * x + world[4] * y + world[8]  * z + world[12];
        var wy = world[1] * x + world[5] * y + world[9]  * z + world[13];
        var wz = world[2] * x + world[6] * y + world[10] * z + world[14];
        var o = i * 8;
        data[o] = wx; data[o + 1] = wy; data[o + 2] = wz;
        if (nrm) {
          var nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
          data[o + 3] = nm[0] * nx + nm[1] * ny + nm[2] * nz;
          data[o + 4] = nm[3] * nx + nm[4] * ny + nm[5] * nz;
          data[o + 5] = nm[6] * nx + nm[7] * ny + nm[8] * nz;
        } else {
          data[o + 5] = 1;
        }
        if (uv) { data[o + 6] = uv[i * 2]; data[o + 7] = uv[i * 2 + 1]; }
        for (var a = 0; a < 3; a++) {
          var w = data[o + a];
          if (w < bboxMin[a]) bboxMin[a] = w;
          if (w > bboxMax[a]) bboxMax[a] = w;
        }
      }

      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

      var group = { vbo: vbo, ibo: null, count: count, idxType: 0,
                    mat: prim.material !== undefined ? materials[prim.material] : null };
      if (prim.indices !== undefined) {
        var idx = readAccessor(json, buf, binOffset, prim.indices);
        group.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, group.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        group.count = idx.length;
        group.idxType = idx.BYTES_PER_ELEMENT === 4 ? gl.UNSIGNED_INT :
                        (idx.BYTES_PER_ELEMENT === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE);
      }
      groups.push(group);
    }

    function walk(nodeIdx, parent) {
      var node = json.nodes[nodeIdx];
      var world = mul(parent, nodeMatrix(node));
      if (node.mesh !== undefined) {
        var prims = json.meshes[node.mesh].primitives;
        for (var p = 0; p < prims.length; p++) addPrimitive(prims[p], world);
      }
      var kids = node.children || [];
      for (var k = 0; k < kids.length; k++) walk(kids[k], world);
    }

    var scene = json.scenes[json.scene || 0];
    for (var n = 0; n < scene.nodes.length; n++) walk(scene.nodes[n], IDENT);

    // bbox -> matriz que centra y normaliza a radio ~1 (via uniform,
    // así no hay que reescribir los buffers)
    var cx = (bboxMin[0] + bboxMax[0]) / 2;
    var cy = (bboxMin[1] + bboxMax[1]) / 2;
    var cz = (bboxMin[2] + bboxMax[2]) / 2;
    var d = Math.max(bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]);
    var s = d > 0 ? 2 / d : 1;
    normMat = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -cy * s, -cz * s, 1];

    // las texturas llegan después: el primer frame sale con baseColorFactor
    for (var t = 0; t < materials.length; t++) {
      if (materials[t].texIndex >= 0) loadTexture(json, buf, binOffset, materials[t]);
      if (materials[t].mrIndex >= 0) loadTexture(json, buf, binOffset, materials[t], 'mr');
    }
  }

  function load() {
    if (loading || loaded) return;
    loading = true;
    fetch(SRC).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('no es un GLB');
      var total = dv.getUint32(8, true);
      var json = null, binOffset = -1;
      var off = 12;
      while (off + 8 <= total) {
        var clen = dv.getUint32(off, true);
        var ctype = dv.getUint32(off + 4, true);
        if (ctype === 0x4E4F534A) {        // 'JSON'
          json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, clen)));
        } else if (ctype === 0x004E4942) { // 'BIN'
          binOffset = off + 8;
        }
        off += 8 + clen + (clen % 4 ? 4 - clen % 4 : 0);
      }
      if (!json || binOffset < 0) throw new Error('GLB incompleto');

      buildScene(json, buf, binOffset);
      gl.enable(gl.DEPTH_TEST);
      // sin culling: hay placas de una sola cara

      loaded = true;
      requestFrame();
    }).catch(function (err) {
      console.error('glb-viewer:', err);
      canvas.style.display = 'none';
    });
  }

  function resize() {
    // ×2: supersampling — se renderiza al doble y el navegador lo reduce
    // al tamaño CSS, suavizando las franjas finas de la grilla
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * 2;
    var w = Math.round(canvas.clientWidth * dpr);
    var h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  /* --- Interacción: arrastrar rota; rueda / pellizco hacen zoom --- */
  var dragging = false, lastX = 0, lastY = 0;
  var pinch0 = 0, pinchDist0 = 0;    // separación inicial de dedos y dist de partida

  function onDown(x, y) { dragging = true; userTouched = true; lastX = x; lastY = y; }
  function onMove(x, y) {
    if (!dragging) return;
    yaw   += (x - lastX) * 0.012;
    pitch += (y - lastY) * 0.012;
    pitch = Math.max(-1.4, Math.min(1.4, pitch));
    lastX = x; lastY = y;
    requestFrame();
  }
  function setDist(d) {
    dist = Math.max(1.3, Math.min(8, d));
    requestFrame();
  }
  function touchGap(e) {
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  canvas.addEventListener('mousedown', function (e) { onDown(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { dragging = false; });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();                   // sobre el modelo la rueda es zoom
    userTouched = true;
    setDist(dist * Math.exp(e.deltaY * 0.0012));
  }, { passive: false });
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      onDown(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      dragging = false;
      userTouched = true;
      pinch0 = touchGap(e);
      pinchDist0 = dist;
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && pinch0 > 0) {
      setDist(pinchDist0 * pinch0 / Math.max(1, touchGap(e)));
      e.preventDefault();                 // el pellizco no hace zoom de página
    } else if (e.touches.length === 1 && dragging) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();                 // rotando no scrolleamos
    }
  }, { passive: false });
  window.addEventListener('touchend', function () { dragging = false; pinch0 = 0; });

  /* --- Loop: corre solo si el canvas está visible y hay algo que animar --- */
  var visible = false, rafId = null, lastTs = 0;

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

    // vaivén suave mientras el usuario no haya tocado (ping-pong, como el post)
    if (!userTouched && !reduce) idleT += dt;
    var idleYaw = userTouched ? 0 : 0.55 * Math.sin(idleT * 0.6);

    var aspect = canvas.width / Math.max(1, canvas.height);
    var proj = perspective(45 * Math.PI / 180, aspect, 0.1, 20);
    var rot = mul(rotX(pitch), rotY(yaw + idleYaw));
    var view = mul(rot, normMat);
    view[14] -= dist;                      // distancia de cámara (zoom)
    var mvp = mul(proj, view);

    gl.clearColor(clearCol[0], clearCol[1], clearCol[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uMVP, false, new Float32Array(mvp));
    // los normales ya llevan su transformación de nodo; lo que queda
    // (rotación + escala uniforme) se reduce a la rotación 3x3
    gl.uniformMatrix3fv(uNormal, false, new Float32Array([
      rot[0], rot[1], rot[2],
      rot[4], rot[5], rot[6],
      rot[8], rot[9], rot[10]
    ]));

    gl.uniform1i(uHasEnv, envCount === 2 ? 1 : 0);

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g.count) continue;
      var mat = g.mat;
      var color = mat ? mat.color : [0.8, 0.8, 0.8, 1];
      var useTex = !!(mat && mat.tex);
      var useMR = !!(mat && mat.mr);
      gl.uniform4f(uBase, color[0], color[1], color[2], color[3]);
      gl.uniform1f(uCutoff, mat ? mat.cutoff : 0);
      gl.uniform1f(uMetal, mat ? mat.metal : 0);
      gl.uniform1f(uRough, mat ? mat.rough : 1);
      gl.uniform1i(uUseTex, useTex ? 1 : 0);
      gl.uniform1i(uUseMR, useMR ? 1 : 0);
      if (useTex) gl.bindTexture(gl.TEXTURE_2D, mat.tex);
      if (useMR) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, mat.mr);
        gl.activeTexture(gl.TEXTURE0);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      var stride = 8 * 4;
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, stride, 6 * 4);
      if (g.ibo) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
        gl.drawElements(gl.TRIANGLES, g.count, g.idxType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, g.count);
      }
    }

    // sigue animando solo si hay movimiento pendiente
    if ((!userTouched && !reduce) || dragging) {
      rafId = requestAnimationFrame(frame);
    }
  }

  /* --- Carga diferida + pausa fuera de pantalla --- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) { load(); requestFrame(); }
      else if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }, { rootMargin: '400px' });
    io.observe(canvas);
  } else {
    visible = true;
    load();
  }

  window.addEventListener('resize', requestFrame);
})();
