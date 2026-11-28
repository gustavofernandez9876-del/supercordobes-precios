// =====================================================================================
// NUBE COMPARTIDA ENTRE CAJAS (Firebase)  —  caja/nube.js   (17/11/2026)
// La caja tenía armada la sincronización (cuentas corrientes, pagos a proveedores, faltantes,
// vencimientos, claves de cajeros, alertas) contra la base de claude.ai, que las cajas no tienen
// porque corren desde GitHub. Este archivo le da a la caja esa misma "base" pero sobre Firebase,
// así todo lo que se anota en Caja 1 aparece en Caja 2 (y en el teléfono) al instante.
// Solo se activa si la página NO corre dentro de claude.ai (ahí sigue usando su propia base).
// También trae la unión de cuentas corrientes (ccMerge3): junta lo que anotó cada caja sin perder nada.
// =====================================================================================
(function(){
"use strict";
var PRUEBA = /[?&]prueba\b/.test(location.search) || /PRUEBA/.test(document.title);
function raiz(){ try{ if (typeof FB_URL !== "undefined" && typeof FB_K !== "undefined") return FB_URL + "/" + FB_K; }catch(e){}
  return "https://supercordobes-322f9-default-rtdb.firebaseio.com/" + (PRUEBA ? "prueba_sc" : "sc_b7Kq29xLmZ"); }
var limpia = function(seg){ return String(seg).replace(/[.#$\[\]]/g, "_"); };
var ruta = function(path){ return String(path).split("/").filter(Boolean).map(limpia).join("/"); };
function url(path, extra){ return raiz() + "/" + ruta(path) + ".json" + (extra || ""); }
function plano(o){ return JSON.parse(JSON.stringify(o === undefined ? null : o)); }

// ---------- Suscripciones en vivo (una conexión por grupo, para no abrir de más) ----------
// Grupo = primer tramo de la ruta (sync, pagosProv, faltantes, alertas) o dias/<d>/<tipo>.
var grupos = {};
function grupoDe(segs){ return segs[0] === "dias" ? segs.slice(0, 3) : segs.slice(0, 1); }
function poner(obj, segs, val){
  if (!segs.length) return val;
  obj = (obj && typeof obj === "object") ? obj : {};
  var k = segs[0];
  if (segs.length === 1){ if (val === null) delete obj[k]; else obj[k] = val; return obj; }
  obj[k] = poner(obj[k], segs.slice(1), val); return obj;
}
function leer(obj, segs){ for (var i = 0; i < segs.length; i++){ if (!obj || typeof obj !== "object") return null; obj = obj[segs[i]]; } return obj === undefined ? null : obj; }
function abrirGrupo(gsegs){
  var key = gsegs.join("/"); if (grupos[key]) return grupos[key];
  var g = grupos[key] = { segs: gsegs, dato: null, listo: false, oyentes: [], es: null };
  function avisar(){ g.oyentes.slice().forEach(function(o){ try{ o(); }catch(e){} }); }
  // El navegador permite ~6 conexiones abiertas por servidor: en vivo (EventSource) van solo las cuentas
  // corrientes y demás "sync" y las ventas del día; el resto se consulta cada 15 segundos. Si no, las
  // demás consultas a la nube quedan esperando y la caja se cuelga.
  var enVivo = (key === "sync") || /^dias\/[^/]+\/ventas$/.test(key);
  function conectar(){
    if (!enVivo || typeof EventSource === "undefined") return consultar();
    try{
      var es = new EventSource(url(key));
      g.es = es;
      var ev = function(tipo){ return function(m){ try{ var d = JSON.parse(m.data); var segs = String(d.path || "/").split("/").filter(Boolean);
        if (tipo === "put") g.dato = poner(g.dato, segs, plano(d.data));
        else { var base = leer(g.dato, segs) || {}; Object.keys(d.data || {}).forEach(function(k){ base = poner(base, [k], plano(d.data[k])); }); g.dato = poner(g.dato, segs, base); }
        g.listo = true; avisar(); }catch(e){} }; };
      es.addEventListener("put", ev("put")); es.addEventListener("patch", ev("patch"));
      es.onerror = function(){ /* EventSource reconecta solo */ };
    }catch(e){ consultar(); }
  }
  function consultar(){
    var ultimo = null;
    var tick = function(){ if (!g.oyentes.length && g.listo) return;
      fetch(url(key), {cache:"no-store"}).then(function(r){ return r.text(); }).then(function(t){ if (t === ultimo && g.listo) return; ultimo = t; g.dato = JSON.parse(t); g.listo = true; avisar(); }).catch(function(){}); };
    tick(); g.timer = setInterval(tick, 15000);
  }
  conectar();
  return g;
}
function suscribir(path, fn){
  var segs = ruta(path).split("/").filter(Boolean), gs = grupoDe(segs), g = abrirGrupo(gs), resto = segs.slice(gs.length);
  var o = function(){ if (g.listo) fn(leer(g.dato, resto)); };
  g.oyentes.push(o); if (g.listo) setTimeout(o, 0);
  return function(){ var i = g.oyentes.indexOf(o); if (i >= 0) g.oyentes.splice(i, 1); };
}

// ---------- API tipo "base de datos" que usa la caja ----------
function docRef(path){
  return {
    set: function(data){
      // Las ventas/cobros/cierres (dias/...) ya las sube registro.js con la versión más nueva: no pisarlas acá.
      if (/^dias\//.test(ruta(path))) return Promise.resolve();
      return fetch(url(path), {method:"PUT", body: JSON.stringify(plano(data))}).then(function(r){ if(!r.ok) throw new Error("nube " + r.status); });
    },
    update: function(data){ return fetch(url(path), {method:"PATCH", body: JSON.stringify(plano(data))}).then(function(r){ if(!r.ok) throw new Error("nube " + r.status); }); },
    delete: function(){ return fetch(url(path), {method:"DELETE"}).then(function(r){ if(!r.ok) throw new Error("nube " + r.status); }); },
    get: function(){ return fetch(url(path), {cache:"no-store"}).then(function(r){ return r.json(); }).then(function(v){ return {exists: v != null, data: function(){ return v; }}; }); },
    onSnapshot: function(cb){ return suscribir(path, function(v){ cb({exists: v != null, data: function(){ return v; }}); }); }
  };
}
function colRef(path){
  return {
    doc: function(id){ return docRef(path + "/" + id); },
    add: function(data){ return fetch(url(path), {method:"POST", body: JSON.stringify(plano(data))}).then(function(r){ return r.json(); }); },
    onSnapshot: function(cb){ return suscribir(path, function(v){ v = v || {}; cb({docs: Object.keys(v).map(function(id){ var x = v[id]; return {id: id, data: function(){ return x; }}; })}); }); }
  };
}
// ---------- Redibujar sin molestar al cajero ----------
// Lo que llega de la nube (ventas de la otra caja, cuentas corrientes, precios) NO redibuja la venta
// mientras alguien está escribiendo (ej. el importe de un 250 "varios"): espera a que termine.
var pendienteRender = false;
function escribiendo(){
  var a = document.activeElement; if (!a) return false;
  var t = (a.tagName || "").toUpperCase(); if (t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") return false;
  if (a.id === "scan" && !a.value) return false;     // el lector vacío no cuenta
  return true;
}
window.renderNube = function(){
  if (typeof render !== "function") return;
  if (escribiendo()){ pendienteRender = true; return; }
  pendienteRender = false; try{ render(); }catch(e){}
};
setInterval(function(){ if (pendienteRender && !escribiendo()) window.renderNube(); }, 1000);

var FBDB = { doc: docRef, collection: colRef, firebase: true, url: url };
window.NUBE_FB = FBDB;
if (!window.claude){
  window.claude = { use: function(nombre){ return Promise.resolve(nombre === "db" ? FBDB : null); } };
}

// ---------- Unión de cuentas corrientes (3 vías) ----------
// base = última versión común conocida; loc = esta caja; rem = la nube.
// Movimientos y pagos se juntan como "multiconjunto": lo que agregó cada lado respecto de la base.
function clave(o){ return JSON.stringify(o); }
function multiset(arr){ var m = new Map(); (arr || []).forEach(function(x){ var k = clave(x); var e = m.get(k); if (e) e.n++; else m.set(k, {n:1, v:x}); }); return m; }
function unir3(b, l, r){
  var B = multiset(b), L = multiset(l), R = multiset(r), out = [], vistos = new Set();
  function agregar(k, v){ if (vistos.has(k)) return; vistos.add(k); var n = (L.get(k)||{n:0}).n + (R.get(k)||{n:0}).n - (B.get(k)||{n:0}).n; for (var i = 0; i < n; i++) out.push(v); }
  (l || []).forEach(function(x){ agregar(clave(x), x); }); (r || []).forEach(function(x){ agregar(clave(x), x); });
  return out;
}
var r2 = function(x){ return Math.round((+x || 0) * 100) / 100; };
function idB(b){ return (b.tipo || "") + "|" + (b.nro || "") + "|" + (b.fecha || ""); }
function unirBoletas(bb, lb, rb){
  var B = new Map((bb||[]).map(function(x){ return [idB(x), x]; })), L = new Map((lb||[]).map(function(x){ return [idB(x), x]; })), R = new Map((rb||[]).map(function(x){ return [idB(x), x]; }));
  var ids = []; (lb||[]).concat(rb||[]).forEach(function(x){ var k = idB(x); if (ids.indexOf(k) < 0) ids.push(k); });
  return ids.map(function(k){
    var b = B.get(k), l = L.get(k), r = R.get(k);
    // Borrada en una caja o en la nube (y sin cambios en la otra): se borra en todas.
    if (!l) return (b && clave(r) === clave(b)) ? null : r; if (!r) return (b && clave(l) === clave(b)) ? null : l;
    if (!b) return clave(l) === clave(r) ? l : (( (l.pagos||[]).length >= (r.pagos||[]).length) ? l : r);
    var x = Object.assign({}, l);
    x.pagos = unir3(b.pagos, l.pagos, r.pagos);
    x.deuda = Math.max(0, r2((+l.deuda||0) + (+r.deuda||0) - (+b.deuda||0)));
    if (x.deuda === 0) x.pagada = l.pagada || r.pagada || x.pagada; else delete x.pagada;
    if (!x.pagos.length) delete x.pagos;
    return x;
  }).filter(function(x){ return x; });
}
function unirCuenta(b, l, r){
  if (!l) return r; if (!r) return l;
  if (!b) b = {saldo: 0, movs: [], boletas: []};
  var x = {};
  Object.keys(Object.assign({}, b, l, r)).forEach(function(k){
    if (k === "movs" || k === "boletas" || k === "saldo") return;
    x[k] = (clave(l[k]) !== clave(b[k])) ? l[k] : r[k];
    if (x[k] === undefined) delete x[k];
  });
  x.movs = unir3(b.movs, l.movs, r.movs);
  x.boletas = unirBoletas(b.boletas, l.boletas, r.boletas);
  x.saldo = r2((+l.saldo||0) + (+r.saldo||0) - (+b.saldo||0));
  if (x.saldo <= 0){ x.saldo = Math.max(0, x.saldo); if (x.saldo === 0) x.desde = null; }
  else { var imp = x.boletas.filter(function(y){ return (+y.deuda||0) > 0; }).map(function(y){ return y.fecha; }).sort(); if (imp.length) x.desde = imp[0]; else x.desde = x.desde || l.desde || r.desde || null; }
  return x;
}
// Forma canónica (claves y listas ordenadas) para comparar contenido sin importar el orden.
function canon(o){
  if (Array.isArray(o)) return o.map(canon).map(function(x){ return [JSON.stringify(x), x]; }).sort(function(a, b){ return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }).map(function(p){ return p[1]; });
  if (o && typeof o === "object"){ var s = {}; Object.keys(o).sort().forEach(function(k){ if (o[k] !== undefined) s[k] = canon(o[k]); }); return s; }
  return o;
}
var igual = function(a, b){ return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); };
window.ccIgual = igual;
// Une listas completas de cuentas. base puede ser null (se toma lo común como base).
// Si el resultado es el mismo contenido que la nube, devuelve el objeto de la nube tal cual
// (así las dos cajas quedan idénticas byte a byte y no se reescriben una a la otra).
window.ccMerge3 = function(base, loc, rem){
  var B = new Map((base||[]).map(function(c){ return [c.id, c]; })), L = new Map((loc||[]).map(function(c){ return [c.id, c]; })), R = new Map((rem||[]).map(function(c){ return [c.id, c]; }));
  var ids = []; (rem||[]).concat(loc||[]).forEach(function(c){ if (ids.indexOf(c.id) < 0) ids.push(c.id); });
  return ids.map(function(id){ var x = unirId(id); var r = R.get(id), l = L.get(id); if (r && igual(x, r)) return r; if (l && igual(x, l)) return l; return x; });
  function unirId(id){
    var b = B.get(id), l = L.get(id), r = R.get(id);
    if (!b && l && r){ // sin base: lo común es la base
      var cm = {}; Object.keys(l).forEach(function(k){ if (clave(l[k]) === clave(r[k])) cm[k] = l[k]; });
      var Lm = multiset(l.movs), comunes = []; (r.movs||[]).forEach(function(m){ var e = Lm.get(clave(m)); if (e && e.n > 0){ e.n--; comunes.push(m); } });
      cm.movs = comunes; cm.boletas = (l.boletas||[]).filter(function(x){ return (r.boletas||[]).some(function(y){ return clave(x) === clave(y); }); });
      cm.saldo = r2(comunes.reduce(function(a, m){ return a + (+m.monto||0); }, 0));
      b = cm;
    }
    return unirCuenta(b, l, r);
  }
};
})();
