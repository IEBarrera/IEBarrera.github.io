/* ---------------------------------------------------------------
   Interlazado (base de la explicación — NO es un patrón de moiré).

   Tres "fotogramas", cada uno un bloque de UN color (sin formas), se
   rebanan en N tiras verticales de ancho S. En la imagen final, la
   columna k proviene del fotograma (k % 3): color0→0,3,6…, color1→1,4,7…,
   color2→2,5,8… Se descarta 2/3 de cada uno (la información se pierde).

   Todo es VECTORIAL: cada tira es un trazo de ancho S que sigue la
   línea central de su carril, así puede curvarse de verdad.

   Recorrido de cada tira superviviente (animación TEMPORAL, disparada
   cuando los bloques llegan al medio de la pantalla):
     1) baja completamente recta la primera mitad del trayecto;
     2) dobla 90° sobre un arco alrededor de un pivote en la esquina
        inferior del bloque (derecha para el bloque izquierdo, izquierda
        para el derecho). Cada línea gira con radio
        R = distancia(pivote, centro de la línea) — la circunferencia
        x = sqrt(R² − y²), expresada en polar (ángulo·R) para no hacer
        raíces. Queda paralela al eje X, viaja hasta el centro y dobla
        otros 90° de la misma forma para caer recta a su columna final
        intercalada. El bloque central baja recto.

   El 2º pivote se corre GAP hacia abajo y hacia afuera del centro: eso
   suma GAP a TODOS los radios del 2º codo (curva más amplia, igual de
   circular) sin mover el punto de llegada. Los radios cumplen
   r + ρ = F + GAP, así todas las tiras recorren la MISMA longitud de
   camino y llegan a la vez, cada una a su columna exacta.

   El scroll solo DISPARA: hasta el trigger nada se separa; la animación
   completa (bajada recta + codos) corre sola con rAF.
   --------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('interlace');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var COLORS = ['#ff6b6b', '#4ecdc4', '#6b8bff']; // los 3 colores de los fotogramas
  var N = 24;              // nº de tiras (múltiplo de 3)
  var M = 14;              // margen: el mismo arriba que a los lados
  var DUR = 3400;          // ms de la animación completa
  var HPI = Math.PI / 2;
  var LBL = 26;            // alto reservado para cada etiqueta de texto

  // Etiquetas: se pasan por data-* desde el post (ahí vive la traducción);
  // si faltan, se elige por el idioma de la página.
  var isEn = (document.documentElement.lang || '').indexOf('en') === 0;
  var LBL_FRAMES = canvas.getAttribute('data-label-frames') ||
    (isEn ? 'animation frames (cropped)' : 'frames de animación (recortados)');
  var LBL_RESULT = canvas.getAttribute('data-label-result') ||
    (isEn ? 'interlaced image' : 'imagen interlazada');
  var textCol = '#111';

  var W, H, dpr, F, S, topY, yMid, drop, finalY, strips, xL;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;

    // Lado F de cada fotograma: a lo ancho caben 3 bloques + márgenes y
    // el corrimiento GAP del 2º codo. La ALTURA del canvas se fija
    // dinámicamente a lo que necesita el recorrido: bloque + bajada
    // recta + F + GAP de codos + F de imagen final + márgenes.
    F = (W - 2 * M) / 3.7;
    S = F / N;
    var GAP = 0.35 * F;               // ensancha el 2º codo
    // + LBL arriba (etiqueta de los frames) y abajo (etiqueta del resultado)
    H = Math.round(2 * M + 3 * F + GAP + 0.45 * F) + 2 * LBL;  // 0.45F de bajada recta
    canvas.style.height = H + 'px';
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // color del texto: el del tema (lo hereda el canvas del body)
    textCol = getComputedStyle(canvas).color || textCol;

    topY   = M + LBL;                 // deja sitio a la etiqueta de arriba
    finalY = H - M - LBL - F;         // dónde se arma la imagen final
    yMid   = finalY - 2 * F - GAP;    // fin de la bajada recta
    drop   = Math.max(0, yMid - topY);

    // bloques pegados a los márgenes laterales; el central, al medio
    xL = [M, W / 2 - F / 2, W - M - F];
    var py = yMid + F;                // y de los pivotes (base del bloque)
    var qy = py + F + GAP;            // y de los centros del 2º codo (= finalY)
    var L  = Math.max(0, W / 2 - F / 2 - GAP - (M + F)); // tramo horizontal

    strips = [];
    for (var f = 0; f < 3; f++) {
      var sgn = f === 0 ? 1 : (f === 2 ? -1 : 0); // hacia dónde dobla
      for (var k = f; k < N; k += 3) {
        var xk = xL[f] + (k + 0.5) * S;           // centro del carril
        var st = { sgn: sgn, color: COLORS[f], xk: xk, py: py };
        if (sgn !== 0) {
          st.px  = sgn > 0 ? xL[f] + F : xL[f];   // pivote 1: esquina inferior
          st.r   = Math.abs(st.px - xk);          // R de esta línea
          st.qx  = W / 2 - sgn * (F / 2 + GAP);   // pivote 2, corrido GAP
          st.qy  = qy;
          st.rho = F + GAP - st.r;                // r + ρ = F + GAP
          st.c1  = st.r * HPI;                    // fin codo 1
          st.c2  = st.c1 + L;                     // fin tramo horizontal
          st.c3  = st.c2 + st.rho * HPI;          // fin codo 2
          st.total = st.c3 + F;                   // caída final (mide F)
        } else {
          st.total = finalY + F - py;             // el central baja recto (2F)
        }
        strips.push(st);
      }
    }
  }

  function ease(u) {                    // easeInOutCubic (fase temporal)
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }

  // Traza el tramo [s0, s1] (longitud de arco sobre la línea central del
  // carril) del camino de una tira: vertical de entrada (s<0), codo 1,
  // horizontal, codo 2 y vertical final. Se pinta con lineWidth = S.
  function strokeTrack(st, s0, s1) {
    if (s1 <= s0) return;
    ctx.beginPath();
    var started = false;
    if (s0 < 0) {                                        // vertical de entrada
      ctx.moveTo(st.xk, st.py + s0);
      ctx.lineTo(st.xk, st.py + Math.min(s1, 0));
      started = true;
    }
    if (st.sgn === 0) {                                  // central: todo recto
      if (s1 > 0) {
        if (!started) ctx.moveTo(st.xk, st.py + s0);
        ctx.lineTo(st.xk, st.py + s1);
      }
    } else {
      var sA, sB;
      if (s1 > 0 && s0 < st.c1) {                        // codo 1 (pivote px,py)
        sA = Math.max(s0, 0) / st.r; sB = Math.min(s1, st.c1) / st.r;
        if (st.sgn > 0) ctx.arc(st.px, st.py, st.r, Math.PI - sA, Math.PI - sB, true);
        else            ctx.arc(st.px, st.py, st.r, sA, sB, false);
        started = true;
      }
      if (s1 > st.c1 && s0 < st.c2) {                    // tramo horizontal
        var yH = st.py + st.r;
        if (!started) { ctx.moveTo(st.px + st.sgn * (Math.max(s0, st.c1) - st.c1), yH); started = true; }
        ctx.lineTo(st.px + st.sgn * (Math.min(s1, st.c2) - st.c1), yH);
      }
      if (s1 > st.c2 && s0 < st.c3) {                    // codo 2 (pivote qx,qy)
        sA = (Math.max(s0, st.c2) - st.c2) / st.rho;
        sB = (Math.min(s1, st.c3) - st.c2) / st.rho;
        if (st.sgn > 0) ctx.arc(st.qx, st.qy, st.rho, 1.5 * Math.PI + sA, 1.5 * Math.PI + sB, false);
        else            ctx.arc(st.qx, st.qy, st.rho, 1.5 * Math.PI - sA, 1.5 * Math.PI - sB, true);
        started = true;
      }
      if (s1 > st.c3) {                                  // caída final
        var xF = st.qx + st.sgn * st.rho;
        if (!started) ctx.moveTo(xF, st.qy + (s0 - st.c3));
        ctx.lineTo(xF, st.qy + (s1 - st.c3));
      }
    }
    ctx.stroke();
  }

  // e: progreso (suavizado) 0..1 de la animación completa
  function draw(e) {
    ctx.clearRect(0, 0, W, H);

    // Etiquetas: la de arriba es fija; la de abajo aparece con la
    // imagen final (fade en el último tramo de la animación).
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = textCol;
    ctx.globalAlpha = 0.62;
    ctx.fillText(LBL_FRAMES, W / 2, topY - 10);
    var a = Math.max(0, (e - 0.88) / 0.12);
    if (a > 0) {
      ctx.globalAlpha = 0.62 * a;
      ctx.fillText(LBL_RESULT, W / 2, finalY + F + 18);
    }
    ctx.globalAlpha = 1;

    ctx.lineWidth = S + 0.6;
    ctx.lineJoin = 'round';

    // 1) Tiras descartadas: se quedan ARRIBA, estáticas y sin cambiar,
    //    para que se vea qué información se pierde.
    for (var f = 0; f < 3; f++) {
      ctx.strokeStyle = COLORS[f];
      for (var k = 0; k < N; k++) {
        if (k % 3 === f) continue;                 // esta sí sobrevive
        var xd = xL[f] + (k + 0.5) * S;
        ctx.beginPath();
        ctx.moveTo(xd, topY);
        ctx.lineTo(xd, topY + F);
        ctx.stroke();
      }
    }

    // 2) Tiras supervivientes: hasta el trigger (e=0) siguen en su bloque
    //    (nada se separa); con e la cabeza avanza de -drop (arriba) hasta
    //    total (columna final). Si el usuario sube, e decae y retroceden.
    for (var j = 0; j < strips.length; j++) {
      var s = strips[j];
      var sHead = -drop + (s.total + drop) * e;
      ctx.strokeStyle = s.color;
      strokeTrack(s, sHead - F, sHead);
    }
  }

  function viewH() {
    return window.innerHeight || document.documentElement.clientHeight;
  }

  // Progreso 0..1 según la posición del canvas en el viewport (scroll).
  // t = 1 justo cuando los bloques iniciales llegan al medio de la pantalla.
  function progress() {
    var r = canvas.getBoundingClientRect();
    var vh = viewH();
    var bc = r.top + topY + F / 2;       // centro de los bloques iniciales
    return Math.max(0, Math.min(1, (vh - bc) / (vh * 0.5)));
  }

  // Fase temporal: cuando los bloques llegan al medio de la pantalla se
  // dispara sola (rAF) y el scroll SIGUE a la animación, llevando el final
  // del canvas a la vista. Si el usuario toma el control o vuelve a subir,
  // se suelta el scroll / se deshace la animación.
  var u = 0, target = 0, rafId = null, lastTs = 0;
  var followFrom = 0, followTo = 0, following = false, lastSet = -1;

  function tick(ts) {
    var dt = Math.min(ts - lastTs, 50); lastTs = ts;
    u += (target > u ? 1 : -1) * dt / DUR;
    u = Math.max(0, Math.min(1, u));
    var e = ease(u);
    if (following && target === 1) {
      var cur = window.pageYOffset || document.documentElement.scrollTop;
      if (lastSet >= 0 && Math.abs(cur - lastSet) > 40) {
        following = false;               // el usuario tomó el control
      } else {
        lastSet = followFrom + (followTo - followFrom) * e;
        window.scrollTo(0, lastSet);
      }
    }
    draw(e);
    rafId = (u !== target) ? requestAnimationFrame(tick) : null;
    if (rafId === null) following = false;
  }

  function update() {
    var t = progress();
    if (target === 1) {
      if (t < 0.85) { target = 0; following = false; }  // histéresis
    } else if (t >= 0.999) {
      target = 1;
      var r = canvas.getBoundingClientRect();
      followFrom = window.pageYOffset || document.documentElement.scrollTop;
      var maxSc = Math.max(0, document.documentElement.scrollHeight - viewH());
      followTo = Math.min(maxSc, followFrom + Math.max(0, r.bottom + 16 - viewH()));
      following = followTo > followFrom;
      lastSet = -1;
    }
    if (u !== target && rafId === null) {
      lastTs = performance.now();
      rafId = requestAnimationFrame(tick);
    } else if (rafId === null) {
      draw(ease(u));
    }
  }

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { update(); ticking = false; });
  }

  var darkMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (darkMq && darkMq.addEventListener) {
    darkMq.addEventListener('change', function () {
      textCol = getComputedStyle(canvas).color || textCol;
      draw(ease(u));
    });
  }

  resize();
  if (reduce) {
    u = 1; draw(1);                    // sin animación: muestra el resultado
  } else {
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { resize(); update(); });
  }
})();
