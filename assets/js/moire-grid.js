/* ---------------------------------------------------------------
   moiré de grillas verticales — dos rejillas batiendo (WebGL)
   Colores según el tema de la página: líneas #f0f0f0 sobre #0d0d0d en
   modo oscuro, líneas #111 sobre blanco en modo claro.

   Loop infinito: la capa móvil se desplaza acumulando fase de forma
   continua, así que nunca hay "salto" de reinicio.

   Hover: la capa que se mueve se DETIENE (su velocidad baja a 0 de
   forma amortiguada) y se OSCURECE, para evidenciarla frente a las
   líneas estáticas. La transición es suave (~0.25 s), no de golpe.
   --------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('moire-grid');
  if (!canvas) return;

  var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) { canvas.style.display = 'none'; return; }  // sin WebGL: se oculta

  var VERT = [
    'attribute vec2 p;',
    'void main(){ gl_Position = vec4(p, 0.0, 1.0); }'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'uniform float u_phase;',    // fase acumulada de la capa móvil (en px)
    'uniform float u_reveal;',   // 0 = normal · 1 = hover (congelada + oscura)

    // Colores según el tema de la página (se setean desde JS):
    'uniform vec3 u_bg;',        // fondo (blanco en claro, negro en oscuro)
    'uniform vec3 u_line;',      // líneas (negras en claro, blancas en oscuro)
    'uniform vec3 u_mid;',       // gris de la capa móvil al revelarla

    // Barras verticales antialiaseadas. Cobertura 0..1.
    // w = derivada por pixel de (x*freq) = freq  -> antialiasing sin extensiones.
    'float bars(float x, float freq){',
    '  float v = abs(fract(x * freq) - 0.5);',   // 0 en el centro, 0.5 en el borde
    '  float w = freq;',
    '  return smoothstep(0.25 + w, 0.25 - w, v);',
    '}',

    // TODO: las frecuencias (0.140/0.147) están en píxeles físicos; en
    // pantallas high-DPI el patrón se ve más denso que en dpr=1. Escalar
    // por dpr (pasarlo como uniform) para igualar el tamaño visual.
    'void main(){',
    '  float x = gl_FragCoord.x;',
    // dos frecuencias casi iguales -> moiré. 'a' se mueve, 'b' es estática.
    '  float a = bars(x + u_phase, 0.140);',
    '  float b = bars(x,           0.147);',
    // Composición por capas: primero las estáticas, luego la móvil encima,
    // que vira a gris con u_reveal para destacarla.
    '  vec3 col = mix(u_bg, u_line, b);',
    '  vec3 aCol = mix(u_line, u_mid, u_reveal);',
    '  col = mix(col, aCol, a);',
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

  // Un quad a pantalla completa (dos triángulos).
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uPhase  = gl.getUniformLocation(prog, 'u_phase');
  var uReveal = gl.getUniformLocation(prog, 'u_reveal');
  var uBg     = gl.getUniformLocation(prog, 'u_bg');
  var uLine   = gl.getUniformLocation(prog, 'u_line');
  var uMid    = gl.getUniformLocation(prog, 'u_mid');

  // Colores según el tema (los mismos --bg / --line del CSS).
  var darkMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    if (darkMq && darkMq.matches) {
      gl.uniform3f(uBg,   0.051, 0.051, 0.051);  // #0d0d0d
      gl.uniform3f(uLine, 0.941, 0.941, 0.941);  // #f0f0f0
      gl.uniform3f(uMid,  0.34,  0.34,  0.34);
    } else {
      gl.uniform3f(uBg,   1.0,   1.0,   1.0);    // #ffffff
      gl.uniform3f(uLine, 0.067, 0.067, 0.067);  // #111111
      gl.uniform3f(uMid,  0.66,  0.66,  0.66);
    }
  }
  applyTheme();
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', applyTheme);

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(canvas.clientWidth  * dpr);
    var h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var SPEED = 3.0;    // px/s de deriva de la capa móvil
  var TAU   = 0.25;   // constante de tiempo del easing (s) -> "suavidad"

  var phase  = 0;     // fase acumulada (nunca se reinicia -> loop sin saltos)
  var reveal = 0;     // valor actual del hover, animado
  var target = 0;     // objetivo del hover: 1 al entrar, 0 al salir
  var last   = performance.now();

  // El hover activa el "revelado": congela y oscurece la capa móvil.
  canvas.addEventListener('mouseenter', function () { target = 1; });
  canvas.addEventListener('mouseleave', function () { target = 0; });

  // TODO: el rAF corre aunque el canvas esté fuera del viewport; pausarlo
  // con un IntersectionObserver.
  function frame(now) {
    resize();
    var dt = Math.min((now - last) / 1000, 0.05);  // clamp por si hay saltos de pestaña
    last = now;

    // Easing exponencial hacia el objetivo: transición suave, no de golpe.
    reveal += (target - reveal) * (1 - Math.exp(-dt / TAU));

    // La velocidad se apaga con el revelado -> se detiene suavemente.
    // Al acumular la fase, congelar en cualquier punto no produce saltos.
    var speed = reduce ? 0 : SPEED * (1 - reveal);
    phase += speed * dt;

    gl.uniform1f(uPhase, phase);
    gl.uniform1f(uReveal, reveal);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
