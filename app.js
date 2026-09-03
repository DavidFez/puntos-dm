/* Lógica de la app. El HTML solo aporta el esqueleto. */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  initializeFirestore, getFirestore,
  persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, updateDoc, addDoc, deleteDoc, getDocs,
  increment, serverTimestamp, arrayUnion,
  query, orderBy, limit, where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* ================================================================
   Firebase
   ================================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyCSna0h_RtHOHII73EHciBaRYPcBLXX6as",
  authDomain: "puntos-dm.firebaseapp.com",
  projectId: "puntos-dm",
  storageBucket: "puntos-dm.firebasestorage.app",
  messagingSenderId: "506501598426",
  appId: "1:506501598426:web:9a10d692f8b93201c1e9e3",
};

const app = initializeApp(firebaseConfig);

// Caché local (IndexedDB): abre al instante con los datos de la última visita,
// funciona sin conexión y evita relecturas. Si el navegador la rechaza, Firestore normal.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  console.warn("Sin caché offline:", e);
  db = getFirestore(app);
}

const docRef = doc(db, "partida", "duelo_actual");

const PASO_HISTORIAL = 20;   // registros por tanda en el historial
const MENSAJES_HORAS = 24;   // vida de un mensaje del día
const reduceMov = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ================================================================
   Utilidades
   ================================================================ */

/** Crea un elemento sin usar innerHTML (el texto del usuario va por textContent). */
function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...hijos.filter((c) => c != null));
  return n;
}

const nombreDe = (usuario) => (usuario === "puntos_m" ? "Mayerli" : "David");

function toast(title, icon = "success") {
  Swal.fire({ toast: true, position: "bottom", timer: 2000, showConfirmButton: false, icon, title, background: "#1e293b", color: "#fff" });
}

function manejarError(e) {
  console.error(e);
  const msg =
    e?.code === "permission-denied" ? "Sin permisos para esta acción." :
    e?.code === "unavailable" ? "Sin conexión: se guardará al reconectar." :
    "Ocurrió un error inesperado.";
  Swal.fire({ icon: "error", title: "Error", text: msg, background: "#1e293b", color: "#fff" });
}

/** Date -> valor para <input type="datetime-local"> (hora local). */
function aInputLocal(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

const limiteMensajes = () => new Date(Date.now() - MENSAJES_HORAS * 3600 * 1000);

function lsGet(k, def) {
  try { return localStorage.getItem(k) ?? def; } catch { return def; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* almacenamiento no disponible */ }
}

/* ================================================================
   Navegación por pestañas
   ================================================================ */

const VISTAS = ["duelo", "historial", "mensajes"];
let vistaActual = "duelo";
let burbujaTimer = null;

function cambiarVista(v) {
  if (!VISTAS.includes(v)) v = "duelo";
  vistaActual = v;

  for (const nombre of VISTAS) {
    document.getElementById(`vista-${nombre}`).hidden = nombre !== v;
  }
  document.querySelectorAll("#tabbar .tab").forEach((b) => {
    const activo = b.dataset.tab === v;
    b.classList.toggle("tab-activo", activo);
    b.setAttribute("aria-current", activo ? "page" : "false");
  });

  window.scrollTo(0, 0);
  if (v === "mensajes") marcarMensajesVistos();
}

function marcarMensajesVistos() {
  lsSet("msgVistos", String(Date.now()));
  document.getElementById("badge-mensajes").hidden = true;
}

/** Burbuja arriba unos segundos cuando llega un mensaje estando en otra pestaña. */
function mostrarBurbuja(texto) {
  const b = document.getElementById("burbuja");
  b.textContent = "💬 " + texto;
  b.hidden = false;
  b.classList.remove("burbuja-anim");
  void b.offsetWidth; // reinicia la animación
  b.classList.add("burbuja-anim");
  clearTimeout(burbujaTimer);
  burbujaTimer = setTimeout(() => { b.hidden = true; }, 5000);
  b.onclick = () => { b.hidden = true; cambiarVista("mensajes"); };
}

/* ================================================================
   Estado del duelo
   ================================================================ */

// "sinFecha"  -> no hay fecha límite: no se puede registrar puntos.
// "enCurso"   -> hay fecha límite en el futuro: todo habilitado.
// "vencido"   -> la fecha límite ya pasó: congelado, se muestra el ganador.
let partidaActual = null;
let estadoActual = "sinFecha";

function calcularEstado(data) {
  if (!data || !data.fecha_limite?.toDate) return "sinFecha";
  return Date.now() >= data.fecha_limite.toDate().getTime() ? "vencido" : "enCurso";
}

const ganadorDe = (m, d) => (m === d ? null : m > d ? "Mayerli" : "David");

/* ================================================================
   Marcador (doc partida/duelo_actual)
   ================================================================ */

const mostrado = {};                               // último valor pintado por id
const previo = { puntos_m: null, puntos_d: null };  // para detectar el cambio

/** Cuenta ascendente/descendente del número con requestAnimationFrame + easing. */
function animarPuntos(id, valorFinal) {
  const nodo = document.getElementById(id);
  const yaVisto = id in mostrado;
  const desde = mostrado[id] ?? 0;

  if (!yaVisto || reduceMov || desde === valorFinal) {
    mostrado[id] = valorFinal;
    nodo.textContent = valorFinal;
    return;
  }

  const dur = 600;
  const t0 = performance.now();
  const paso = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    nodo.textContent = Math.round(desde + (valorFinal - desde) * eased);
    if (p < 1) requestAnimationFrame(paso);
    else mostrado[id] = valorFinal;
  };
  requestAnimationFrame(paso);
}

/** Número flotante +N / -N que sube y se desvanece. */
function flote(id, delta) {
  if (reduceMov || !delta) return;
  const n = document.getElementById(id);
  n.textContent = (delta > 0 ? "+" : "") + delta;
  n.classList.remove("activo");
  void n.offsetWidth; // reinicia la animación
  n.classList.add("activo");
}

/** Marco brillante para el que gana, apagado para el que pierde. */
function marcarGanador(m, d) {
  const fm = document.getElementById("foto-m");
  const fd = document.getElementById("foto-d");
  fm.classList.remove("foto-ganador", "foto-perdedor");
  fd.classList.remove("foto-ganador", "foto-perdedor");
  if (m === d) return;
  const ganaM = m > d;
  fm.classList.add(ganaM ? "foto-ganador" : "foto-perdedor");
  fd.classList.add(ganaM ? "foto-perdedor" : "foto-ganador");
}

/** Barras relativas: el líder llega al 100%, la otra muestra la distancia. */
function actualizarBarras(m, d) {
  const max = Math.max(m, d, 1);
  document.getElementById("barra-m").style.width = `${(Math.max(m, 0) / max) * 100}%`;
  document.getElementById("barra-d").style.width = `${(Math.max(d, 0) / max) * 100}%`;
}

const frasesMayerliGana = [
  "¡Mayerli está imparable! ✨",
  "David, ¡tienes que esforzarte más bebé! 😂",
  "Reina absoluta del marcador 👑",
  "¿Alguien puede alcanzar a esta hermosa 🥰?",
  "Mayerli lleva la delantera con estilo 😘",
];
const frasesDavidGana = [
  "¡David tomó la delantera! 😎",
  "Mayerli, no se deje ganar bebé 😜",
  "¡Poder David activado! 🔥",
  "David líder de la tabla bebé 😎",
  "David está en su mejor momento 😌",
];
const frasesEmpate = [
  "¿Cómo arreglamos ese empate bebé? 😈",
  "¿Qué hacemos para ganar mas puntos? 😏",
  "¿Nos enviamos fotitos hot para desempatar? 😏",
  "¡Arreglamos ese empate en el escritorio! 🔥",
  "Nos arreglamos con besitos ese empate 😋",
];

function actualizarMensaje(m, d) {
  const lista = m === d ? frasesEmpate : m > d ? frasesMayerliGana : frasesDavidGana;
  document.getElementById("mensaje-motivador").textContent =
    lista[Math.floor(Math.random() * lista.length)];
}

/** Pinta el marcador. Solo se llama cuando llega un snapshot nuevo del doc. */
function renderMarcador() {
  const m = partidaActual?.puntos_m ?? 0;
  const d = partidaActual?.puntos_d ?? 0;

  animarPuntos("puntos-m", m);
  animarPuntos("puntos-d", d);

  if (previo.puntos_m !== null && m !== previo.puntos_m) { flote("flote-m", m - previo.puntos_m); navigator.vibrate?.(20); }
  if (previo.puntos_d !== null && d !== previo.puntos_d) { flote("flote-d", d - previo.puntos_d); navigator.vibrate?.(20); }
  previo.puntos_m = m;
  previo.puntos_d = d;

  actualizarBarras(m, d);
  marcarGanador(m, d);
  actualizarMensaje(m, d);
  document.getElementById("sr-marcador").textContent = `Mayerli ${m} puntos, David ${d} puntos`;
}

/* ================================================================
   Estado de la UI (habilitar/bloquear según fecha límite)
   ================================================================ */

/** Cuenta regresiva hasta la fecha límite (o estado si no hay / ya venció). */
function renderMeta() {
  const span = document.getElementById("meta-fecha");
  const fl = partidaActual?.fecha_limite;
  if (!fl?.toDate) {
    span.textContent = "sin definir";
    span.className = "text-slate-500 font-mono";
    return;
  }
  const fin = fl.toDate();
  const ms = fin.getTime() - Date.now();
  if (ms <= 0) {
    span.textContent = `venció el ${fin.toLocaleDateString()}`;
    span.className = "text-red-400 font-mono font-bold";
    return;
  }
  const dias = Math.floor(ms / 86400000);
  const horas = Math.floor((ms % 86400000) / 3600000);
  span.textContent = `${dias}d ${horas}h · ${fin.toLocaleDateString()}`;
  span.className = dias < 3 ? "text-red-400 font-mono font-bold" : "text-pink-400 font-mono";
}

function renderEstado() {
  estadoActual = calcularEstado(partidaActual);
  renderMeta();

  const banner = document.getElementById("banner");
  const formRegistro = document.getElementById("form-registro");
  const formRecompensa = document.getElementById("recompensas-form");
  const tituloRecompensas = document.getElementById("recompensas-titulo");

  const m = partidaActual?.puntos_m ?? 0;
  const d = partidaActual?.puntos_d ?? 0;

  if (estadoActual === "enCurso") {
    banner.hidden = true;
    formRegistro.disabled = false;
    formRecompensa.disabled = false;
    tituloRecompensas.textContent = "Recompensas";
  } else if (estadoActual === "sinFecha") {
    banner.hidden = false;
    banner.className = "text-center text-sm font-medium rounded-xl px-4 py-3 bg-amber-500/15 text-amber-300 border border-amber-500/30";
    banner.textContent = "Define una fecha límite para empezar a registrar puntos.";
    formRegistro.disabled = true;
    formRecompensa.disabled = true;
    tituloRecompensas.textContent = "Recompensas";
  } else { // vencido
    const g = ganadorDe(m, d);
    banner.hidden = false;
    banner.className = "text-center text-sm font-medium rounded-xl px-4 py-3 bg-violet-500/15 text-violet-200 border border-violet-500/30";
    banner.textContent = g
      ? `🏆 Ganó ${g}. Define una nueva fecha límite para seguir.`
      : "Empate. Define una nueva fecha límite para seguir.";
    formRegistro.disabled = true;
    formRecompensa.disabled = true;
    tituloRecompensas.textContent = g ? `🏆 Premios de ${g}` : "🏆 Premios (empate)";
  }
}

/* ================================================================
   Recompensas (campo array en el doc del duelo)
   ================================================================ */

function renderRecompensas() {
  const cont = document.getElementById("recompensas-lista");
  const lista = [...(partidaActual?.recompensas ?? [])].sort((a, b) => (a.creada ?? 0) - (b.creada ?? 0));
  cont.replaceChildren();

  if (!lista.length) {
    cont.append(el("p", { class: "text-xs text-slate-500 italic", text: "Todavía no hay recompensas." }));
    return;
  }

  const puedeBorrar = estadoActual === "enCurso";
  for (const r of lista) {
    cont.append(el("div", { class: "flex items-center justify-between gap-2 bg-slate-800/60 rounded-xl px-3 py-2" },
      el("span", { class: "text-sm text-slate-200 break-words min-w-0", text: r.texto }),
      puedeBorrar
        ? el("button", { type: "button", class: "text-slate-500 hover:text-red-400 text-lg leading-none shrink-0", "aria-label": "Quitar recompensa", onclick: () => borrarRecompensa(r.creada) }, "×")
        : null,
    ));
  }
}

async function agregarRecompensa() {
  const input = document.getElementById("recompensa-input");
  const texto = input.value.trim();
  if (!texto) return;
  try {
    await updateDoc(docRef, { recompensas: arrayUnion({ texto, creada: Date.now() }) });
    input.value = "";
    toast("Recompensa agregada");
  } catch (e) {
    manejarError(e);
  }
}

async function borrarRecompensa(creada) {
  const lista = (partidaActual?.recompensas ?? []).filter((r) => r.creada !== creada);
  try {
    await updateDoc(docRef, { recompensas: lista });
  } catch (e) {
    manejarError(e);
  }
}

/* ================================================================
   Acciones: fecha límite y reinicio de ronda
   ================================================================ */

async function definirFecha() {
  const actual = partidaActual?.fecha_limite?.toDate?.();
  const prefill = actual ? aInputLocal(actual) : "";

  const { value } = await Swal.fire({
    title: "Fecha límite del duelo",
    html: `<input id="sw-fecha" type="datetime-local" class="swal2-input" value="${prefill}">`,
    showCancelButton: true,
    confirmButtonText: "Guardar",
    cancelButtonText: "Cancelar",
    confirmButtonColor: "#8b5cf6",
    background: "#1e293b",
    color: "#fff",
    preConfirm: () => {
      const v = document.getElementById("sw-fecha").value;
      if (!v) { Swal.showValidationMessage("Elige fecha y hora"); return false; }
      const dt = new Date(v);
      if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
        Swal.showValidationMessage("Debe ser una fecha futura");
        return false;
      }
      return dt;
    },
  });
  if (!value) return;

  try {
    await updateDoc(docRef, { fecha_limite: value });
    toast("Fecha límite guardada");
  } catch (e) {
    manejarError(e);
  }
}

async function reiniciarRonda() {
  const { isConfirmed } = await Swal.fire({
    icon: "warning",
    title: "¿Reiniciar la ronda?",
    text: "Los puntos vuelven a 0 y se borran las recompensas. El historial se conserva. Tendrás que definir una nueva fecha límite.",
    showCancelButton: true,
    confirmButtonColor: "#ef4444",
    confirmButtonText: "Reiniciar",
    cancelButtonText: "Cancelar",
    background: "#1e293b",
    color: "#fff",
  });
  if (!isConfirmed) return;

  try {
    await updateDoc(docRef, { puntos_m: 0, puntos_d: 0, recompensas: [], fecha_limite: null });
    toast("Nueva ronda. Define la fecha límite.");
  } catch (e) {
    manejarError(e);
  }
}

/* ================================================================
   Listener del duelo
   ================================================================ */

onSnapshot(docRef, (snap) => {
  partidaActual = snap.exists() ? snap.data() : null;
  renderMarcador();
  renderEstado();
  renderRecompensas();
}, (e) => console.error("duelo:", e));

// La transición enCurso -> vencido ocurre por el paso del tiempo, no por una
// escritura, así que revisamos el estado cada 30 s.
setInterval(() => {
  const antes = estadoActual;
  renderEstado();
  if (estadoActual !== antes) renderRecompensas();
}, 30000);

/* ================================================================
   Historial (colección historial, paginado)
   ================================================================ */

let unsubHistorial = null;
let limiteHistorial = PASO_HISTORIAL;

function tarjetaHistorial(item, fecha) {
  const hora = fecha.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const esQuitar = item.tipo === "quitar";

  return el("div", { class: "bg-slate-900/50 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm gap-2" },
    el("div", { class: "text-left flex-1 min-w-0" },
      el("div", { class: "flex items-center gap-2" },
        el("p", { class: "text-sm font-semibold text-slate-200", text: nombreDe(item.usuario) }),
        el("span", { class: "text-[10px] text-slate-500 font-mono", text: hora }),
      ),
      el("p", { class: "text-xs text-slate-400 mt-1 leading-relaxed break-words", text: item.motivo || "—" }),
    ),
    el("span", {
      class: `font-bold text-lg whitespace-nowrap ${esQuitar ? "text-red-400" : "text-emerald-400"}`,
      text: `${esQuitar ? "−" : "+"}${item.cantidad}`,
    }),
  );
}

function divisorDia(texto) {
  return el("div", { class: "flex items-center gap-4 my-4" },
    el("div", { class: "h-px bg-slate-800 flex-1" }),
    el("span", { class: "text-[10px] uppercase tracking-widest text-slate-500 font-bold", text: texto }),
    el("div", { class: "h-px bg-slate-800 flex-1" }),
  );
}

function renderHistorial(docs) {
  const lista = document.getElementById("historial-lista");

  if (!docs.length) {
    lista.replaceChildren(el("p", {
      class: "text-center text-sm text-slate-500 italic py-8",
      text: "Sin actividad todavía. ¡Registra el primer punto!",
    }));
    return;
  }

  const frag = document.createDocumentFragment();
  let ultimoDia = "";
  for (const item of docs) {
    const fecha = item.fecha.toDate();
    const dia = fecha.toLocaleDateString([], { day: "2-digit", month: "long" });
    if (dia !== ultimoDia) {
      ultimoDia = dia;
      frag.append(divisorDia(dia));
    }
    frag.append(tarjetaHistorial(item, fecha));
  }
  lista.replaceChildren(frag); // un solo reemplazo del DOM, no innerHTML += en bucle
}

function suscribirHistorial() {
  unsubHistorial?.();
  const q = query(collection(db, "historial"), orderBy("fecha", "desc"), limit(limiteHistorial));
  unsubHistorial = onSnapshot(q, (snap) => {
    const docs = snap.docs.map((d) => d.data()).filter((x) => x.fecha?.toDate);
    document.getElementById("btn-mas").hidden = snap.size < limiteHistorial;
    renderHistorial(docs);
  }, (e) => console.error("historial:", e));
}

/* ================================================================
   Mensajes del día (colección mensajes, efímera)
   ================================================================ */

let unsubMensajes = null;
let ultimoMsgTs = 0;          // ts del mensaje más reciente ya conocido
let mensajesArrancados = false;

/** Normaliza y filtra a los mensajes aún vivos, del más nuevo al más viejo. */
function msgVivos(msgs) {
  const corte = limiteMensajes().getTime();
  return msgs
    .filter((x) => x.fecha?.toDate)
    .map((x) => ({ texto: x.texto, ts: x.fecha.toDate().getTime() }))
    .filter((x) => x.ts > corte)
    .sort((a, b) => b.ts - a.ts);
}

function renderMensajes(vivos) {
  const cont = document.getElementById("mensajes-lista");
  cont.replaceChildren();

  if (!vivos.length) {
    cont.append(el("p", { class: "text-xs text-slate-500 italic", text: "Sin mensajes ahora mismo." }));
    return;
  }

  for (const msg of vivos) {
    const hora = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    cont.append(el("div", { class: "bg-slate-800/60 rounded-xl px-3 py-2 flex justify-between gap-2" },
      el("span", { class: "text-sm text-slate-200 break-words min-w-0", text: msg.texto }),
      el("span", { class: "text-[10px] text-slate-500 font-mono shrink-0", text: hora }),
    ));
  }
}

function actualizarBadgeMensajes(vivos) {
  const badge = document.getElementById("badge-mensajes");
  const vistos = Number(lsGet("msgVistos", "0")) || 0;
  const nuevos = vivos.filter((m) => m.ts > vistos).length;
  if (nuevos > 0 && vistaActual !== "mensajes") {
    badge.textContent = nuevos > 9 ? "9+" : String(nuevos);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function suscribirMensajes() {
  unsubMensajes?.();
  const q = query(
    collection(db, "mensajes"),
    where("fecha", ">", limiteMensajes()),
    orderBy("fecha", "desc"),
    limit(50),
  );
  unsubMensajes = onSnapshot(q, (snap) => {
    const vivos = msgVivos(snap.docs.map((d) => d.data()));
    renderMensajes(vivos);

    const nuevoUltimo = vivos.length ? vivos[0].ts : 0;
    if (mensajesArrancados && nuevoUltimo > ultimoMsgTs && vistaActual !== "mensajes") {
      mostrarBurbuja(vivos[0].texto);
    }
    ultimoMsgTs = Math.max(ultimoMsgTs, nuevoUltimo);
    mensajesArrancados = true;

    if (vistaActual === "mensajes") marcarMensajesVistos();
    actualizarBadgeMensajes(vivos);
  }, (e) => console.error("mensajes:", e));
}

async function enviarMensaje() {
  const input = document.getElementById("mensaje-input");
  const texto = input.value.trim();
  if (!texto) return;
  try {
    // Fecha del cliente (no serverTimestamp): así aparece al instante y nunca es null.
    await addDoc(collection(db, "mensajes"), { texto, fecha: new Date() });
    input.value = "";
    limpiarMensajesViejos();
  } catch (e) {
    manejarError(e);
  }
}

/** Borra de Firestore los mensajes que ya expiraron (best-effort). */
async function limpiarMensajesViejos() {
  try {
    const viejos = await getDocs(query(
      collection(db, "mensajes"),
      where("fecha", "<", limiteMensajes()),
      limit(50),
    ));
    await Promise.all(viejos.docs.map((d) => deleteDoc(d.ref)));
  } catch (e) {
    console.warn("limpieza de mensajes:", e);
  }
}

/* ================================================================
   Registrar puntos
   ================================================================ */

window.enviarAccion = async (tipo) => {
  if (estadoActual !== "enCurso") {
    return Swal.fire({
      icon: "info",
      title: "No disponible",
      text: estadoActual === "sinFecha"
        ? "Primero define una fecha límite."
        : "La fecha límite ya venció. Define una nueva para seguir.",
      background: "#1e293b",
      color: "#fff",
    });
  }

  const usuario = document.getElementById("input-usuario").value;
  const motivo = document.getElementById("input-motivo").value.trim();
  const cantidad = parseInt(document.getElementById("input-puntos").value, 10);

  if (!usuario) {
    return Swal.fire({ icon: "warning", title: "¿A quién?", text: "Primero selecciona a quién, bebé", background: "#1e293b", color: "#fff" });
  }
  if (!cantidad || cantidad <= 0 || !motivo) {
    return Swal.fire({ icon: "error", title: "¡Oops!", text: "Pon los puntos (mayores a 0) y el motivo, bebé", background: "#1e293b", color: "#fff" });
  }

  const { isConfirmed } = await Swal.fire({
    icon: "question",
    title: "¿Confirmar?",
    text: `${tipo === "quitar" ? "Restar" : "Sumar"} ${cantidad} puntos a ${nombreDe(usuario)}`,
    showCancelButton: true,
    confirmButtonColor: "#8b5cf6",
    confirmButtonText: "Sí",
    cancelButtonText: "Cancelar",
    background: "#1e293b",
    color: "#fff",
  });
  if (!isConfirmed) return;

  try {
    const efecto = tipo === "quitar" ? -cantidad : cantidad;
    await updateDoc(docRef, { [usuario]: increment(efecto) });
    await addDoc(collection(db, "historial"), {
      usuario, tipo, cantidad, motivo, fecha: serverTimestamp(),
    });
    document.getElementById("input-puntos").value = "";
    document.getElementById("input-motivo").value = "";
    toast("Registrado");
  } catch (e) {
    manejarError(e);
  }
};

/* ================================================================
   Arranque
   ================================================================ */

document.getElementById("btn-fecha").addEventListener("click", definirFecha);
document.getElementById("btn-reiniciar").addEventListener("click", reiniciarRonda);

document.getElementById("btn-recompensa").addEventListener("click", agregarRecompensa);
document.getElementById("recompensa-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") agregarRecompensa();
});

document.getElementById("btn-mensaje").addEventListener("click", enviarMensaje);
document.getElementById("mensaje-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") enviarMensaje();
});

document.getElementById("btn-mas").addEventListener("click", () => {
  limiteHistorial += PASO_HISTORIAL;
  suscribirHistorial();
});

document.querySelectorAll("#tabbar .tab").forEach((b) => {
  b.addEventListener("click", () => cambiarVista(b.dataset.tab));
});
cambiarVista("duelo");

suscribirHistorial();
suscribirMensajes();
limpiarMensajesViejos();

// Refresca el corte de los mensajes del día cada 30 min.
setInterval(() => {
  suscribirMensajes();
  limpiarMensajesViejos();
}, 30 * 60 * 1000);
