// =====================================================================================
// REGISTRO COMPLETO EN LA NUBE (Firebase de Gustavo)  —  caja/registro.js
// Regla de Gustavo (17/11/2026): todo lo que se vende, cobra, carga o mueve queda
// registrado en la nube, sin excepción, y la nube tiene que ser igual a la copia local.
//
// Qué hace:
//  1. Cola de envío sin pérdidas: cada registro (ventas, cobros, cierres, compras, stock,
//     productos...) se encola y se reintenta hasta que Firebase confirma. No hay límite de días.
//  2. Control: cada 10 minutos compara lo que tiene esta compu con lo que hay en la nube,
//     día por día, y vuelve a mandar lo que falte.
//  3. Estado: copia en la nube de cuentas corrientes, vencimientos, pagos a proveedores,
//     faltantes, fondos, clientes y productos modificados de cada caja.
//  4. Productos: altas y cambios de precio se comparten entre todas las cajas (prod/<cod>).
//  5. Stock: stock.json + entradas (boletas, remitos, ajustes) − ventas de TODAS las cajas.
// Depende de variables del index.html: FB_URL, FB_K, MAQ, slug, diaISO, ventas, cobros,
// cierres, FONDOS, prodEdits, PRODUCTOS, STOCK, aNube, aplicarEditsProd, indexar.
// =====================================================================================
(function(){
"use strict";
const REG = window.REG = {};
const FB = (p)=>`${FB_URL}/${FB_K}/${p}.json`;
const limpiaId = id => String(id).replace(/[.#$\[\]\/]/g,"_");
const cajaSlug = ()=>slug(($("caja")&&$("caja").value)||"caja")||"caja";
const ls = (k,d)=>{ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } };
const lsW = (k,v)=>{ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch(e){ REG.errorEspacio=true; return false; } };
const diaDe = o => o.dia || dmy2iso(o.fecha) || (o.ts?diaISO(o.ts):diaISO(new Date()));

// ---------- 1. Cola de envío ----------
// Para ventas, cobros y cierres solo se guarda la referencia (el dato ya está en esta compu):
// así la cola no ocupa espacio. Para el resto se guarda el registro completo.
const GRANDES = {ventas:()=>ventas, cobros:()=>cobros, cierres:()=>cierres};
let COLA = ls("cajaFBQ", []);
const guardarCola = ()=>lsW("cajaFBQ", COLA);
function encolar(tipo, obj){
  if(!obj||!obj.id) return;
  const dia = diaDe(obj);
  const item = {tipo, id:obj.id, dia};
  if(!GRANDES[tipo]) item.obj = JSON.parse(JSON.stringify(obj));
  if(COLA.some(x=>x.tipo===tipo && x.id===obj.id)) return;
  COLA.push(item); guardarCola(); enviar();
}
REG.encolar = encolar;
function resolver(it){
  if(it.obj) return it.obj;
  const arr = GRANDES[it.tipo] ? GRANDES[it.tipo]() : [];
  const o = arr.find(x=>x && x.id===it.id);
  return o ? {...o, dia: it.dia} : null;
}
let enviando=false; REG.ultimoOK=0; REG.ultimoError="";
async function enviar(){
  if(enviando || !COLA.length || !navigator.onLine){ pintar(); return; }
  enviando=true;
  try{
    while(COLA.length){
      const it = COLA[0], o = resolver(it);
      if(o){
        const r = await fetch(FB(`dias/${it.dia}/${it.tipo}/${limpiaId(it.id)}`), {method:"PUT", body:JSON.stringify(JSON.parse(JSON.stringify(o)))});
        if(!r.ok) throw new Error("Firebase respondió "+r.status);
      }
      COLA.shift(); guardarCola();
    }
    REG.ultimoOK=Date.now(); REG.ultimoError="";
  }catch(e){ REG.ultimoError=String(e.message||e); }
  enviando=false; pintar();
}
REG.enviar = enviar;
setInterval(enviar, 15000); window.addEventListener("online", enviar);

// Todo lo que ya pasaba por aNube (ventas, cobros, compras A) ahora también va a Firebase.
const aNubeOriginal = aNube;
aNube = function(tipo, obj){ aNubeOriginal(tipo, obj); try{ encolar(tipo, obj); }catch(e){} if(tipo==="ventas") setTimeout(()=>{ try{ recalcular(); }catch(e){} }, 0); };
// Cierres de caja: antes iban solo los últimos 3 días a Firebase.
const pushCierres = cierres.push;
cierres.push = function(...a){ const r = pushCierres.apply(this, a); a.forEach(c=>{ try{ if(!c.id) c.id=cajaSlug()+"-"+MAQ+"-cierre-"+Date.now(); encolar("cierres", c); }catch(e){} }); return r; };

// ---------- 2. Control nube = esta compu ----------
REG.control = {t:0, faltaban:0, dias:0, error:""};
async function controlar(){
  if(!navigator.onLine) return;
  const porDia = {};
  const juntar = (tipo, arr)=>(arr||[]).forEach(o=>{ if(!o) return; const d=diaDe(o);
    // Registros viejos sin id: mismo id que les pone la subida de 3 días del index.html.
    if(!o.id) o.id=slug(o.caja||$("caja").value)+"-"+MAQ+"-"+d+"-"+(o.nro!=null?o.nro:String(o.hora||"").replace(/\D/g,"")+"-"+Math.round(o.monto||o.total||0)); ((porDia[d]=porDia[d]||{})[tipo]=porDia[d][tipo]||[]).push(o); });
  juntar("ventas", ventas); juntar("cobros", cobros); juntar("cierres", cierres);
  let faltan=0;
  try{
    for(const d of Object.keys(porDia).sort()){
      for(const tipo of Object.keys(porDia[d])){
        const r = await fetch(FB(`dias/${d}/${tipo}`)+"?shallow=true"); if(!r.ok) throw new Error("lectura "+r.status);
        const hay = new Set(Object.keys((await r.json())||{}));
        porDia[d][tipo].forEach(o=>{ if(!hay.has(limpiaId(o.id))){ faltan++; encolar(tipo, o); } });
      }
    }
    REG.control = {t:Date.now(), faltaban:faltan, dias:Object.keys(porDia).length, error:""};
  }catch(e){ REG.control.error=String(e.message||e); }
  pintar();
}
REG.controlar = controlar;
setTimeout(controlar, 8000); setInterval(controlar, 10*60*1000);

// ---------- 3. Estado de cada caja ----------
// (Las claves de cajeros no se suben: ya viajan por la base del artifact y Firebase no tiene clave.)
const ESTADO = ["cajaCC","cajaVenc","cajaPagosProv","cajaFalt","cajaComprasA","cajaFondos","cajaCliEdits","cajaClientesRI","cajaProdEdits","cajaArca"];
let estadoEnviado = ls("cajaFBEstado", {});
async function subirEstado(){
  if(!navigator.onLine) return;
  for(const k of ESTADO){
    let v=null; try{ v=localStorage.getItem(k); }catch(e){}
    if(v==null) continue;
    const firma = v.length+":"+hash(v);
    if(estadoEnviado[k]===firma) continue;
    // Por caja Y por máquina: dos PC con el mismo nombre de caja no se pisan.
    try{ const r=await fetch(FB(`estado/${cajaSlug()}_${MAQ}/${k}`),{method:"PUT",body:JSON.stringify({json:v,t:Date.now(),maq:MAQ})}); if(r.ok){ estadoEnviado[k]=firma; lsW("cajaFBEstado",estadoEnviado); } }catch(e){}
  }
}
function hash(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return h; }
setTimeout(subirEstado, 12000); setInterval(subirEstado, 60000);

// ---------- 4. Productos compartidos entre cajas ----------
// Cada alta o cambio (desde Productos o desde Cargar boleta) se sube a prod/<cod> y se registra
// como movimiento "productos". Las demás cajas lo bajan cada minuto.
let prodEnviado = ls("cajaFBProd", {});
function firmaProd(e){ return hash(JSON.stringify(e)); }
async function subirProductos(){
  if(!navigator.onLine||typeof prodEdits==="undefined") return;
  for(const [cod,e] of Object.entries(prodEdits)){
    if(prodEnviado[cod]===firmaProd(e)) continue;
    // Cambio local nuevo: lleva la hora de ahora, así las otras cajas lo toman como el más reciente.
    e.ts = Date.now(); lsW("cajaProdEdits", prodEdits);
    const f = firmaProd(e);
    const reg = {...e, cod, ts: e.ts, caja: $("caja").value, maq: MAQ};
    try{
      const r = await fetch(FB(`prod/${limpiaId(cod)}`),{method:"PUT",body:JSON.stringify(reg)});
      if(!r.ok) continue;
      const ult = (e.hist||[]).slice(-1)[0]||{};
      encolar("productos", {id: limpiaId(cod)+"-"+reg.ts, cod, ts:reg.ts, dia:diaISO(reg.ts), caja:$("caja").value, nuevo:!!e.nuevo, datos:e.datos, ultimo:ult});
      prodEnviado[cod]=f; lsW("cajaFBProd",prodEnviado);
    }catch(err){}
  }
}
async function bajarProductos(){
  if(!navigator.onLine||typeof prodEdits==="undefined") return;
  try{
    const r = await fetch(FB("prod")); if(!r.ok) return; const todo = (await r.json())||{};
    let cambio=false;
    Object.values(todo).forEach(x=>{ if(!x||!x.cod) return; const loc=prodEdits[x.cod];
      if(!loc || (x.ts||0) > (loc.ts||0)){ if(loc && firmaProd(loc)!==prodEnviado[x.cod]) return; // cambio local sin subir: gana el local (se sube en el próximo ciclo)
        const e={nuevo:!!x.nuevo, datos:x.datos||{}, hist:x.hist||[], ts:x.ts}; prodEdits[x.cod]=e; prodEnviado[x.cod]=firmaProd(e); cambio=true; } });
    if(cambio){ lsW("cajaProdEdits",prodEdits); lsW("cajaFBProd",prodEnviado); try{ aplicarEditsProd(); indexar(); }catch(e){} if(window.renderNube) window.renderNube(); else try{ render(); }catch(e){} }
  }catch(e){}
}
REG.subirProductos=subirProductos; REG.bajarProductos=bajarProductos;
setTimeout(async()=>{ await subirProductos(); await bajarProductos(); }, 5000);
setInterval(async()=>{ await subirProductos(); await bajarProductos(); }, 60000);

// ---------- 5. Stock de todas las cajas ----------
// stock = stock.json (base) + entradas/ajustes (dias/<d>/stock) − ventas (dias/<d>/ventas) de todas las cajas.
let STK = ls("cajaFBStock", {}); // { dia: {n:cantidadRegistros, agg:{cod:q}} }
let STK_HOY = {ventas:new Map(), stock:new Map()};
REG.stockListo=false;
function sumarItems(agg, items, signo){ (items||[]).forEach(i=>{ if(!i||!i.cod) return; agg[i.cod]=(agg[i.cod]||0)+signo*(+i.q||0); }); }
function aggVenta(agg, v){ if(!v||!v.items) return; if(v.nc){ if(v.devuelveStock) v.items.forEach(i=>{ agg[i.cod]=(agg[i.cod]||0)+Math.abs(+i.q||0); }); return; } sumarItems(agg, v.items, -1); }
function baseISO(){ return dmy2iso(STOCK&&STOCK.fecha) || "2026-10-28"; }
async function cargarDia(d, completo){
  const out={n:0, agg:{}};
  const rv=await fetch(FB(`dias/${d}/ventas`)); if(!rv.ok) throw 0; const vs=(await rv.json())||{};
  const rs=await fetch(FB(`dias/${d}/stock`)); if(!rs.ok) throw 0; const ss=(await rs.json())||{};
  Object.values(vs).forEach(v=>aggVenta(out.agg,v)); Object.values(ss).forEach(s=>{ if(!s.anulado) sumarItems(out.agg, s.items, 1); });
  out.n = Object.keys(vs).length+"/"+Object.keys(ss).length;
  if(completo) return {out, vs, ss}; return {out};
}
async function actualizarStock(){
  if(!navigator.onLine) return;
  try{
    const r=await fetch(FB("dias")+"?shallow=true"); if(!r.ok) return; const dias=Object.keys((await r.json())||{}).sort();
    const hoy=diaISO(new Date()), base=baseISO();
    for(const d of dias){ if(d<base||d>=hoy) continue;
      // Día pasado: se baja entero solo si cambió la cantidad de registros.
      const [rv,rs]=await Promise.all([fetch(FB(`dias/${d}/ventas`)+"?shallow=true"),fetch(FB(`dias/${d}/stock`)+"?shallow=true")]);
      const n=Object.keys((await rv.json())||{}).length+"/"+Object.keys((await rs.json())||{}).length;
      if(STK[d]&&STK[d].n===n) continue;
      const {out}=await cargarDia(d); STK[d]=out; }
    Object.keys(STK).forEach(d=>{ if(!dias.includes(d)||d<base) delete STK[d]; });
    lsW("cajaFBStock", STK);
    const {vs,ss}=await cargarDia(hoy,true);
    STK_HOY={ventas:new Map(Object.values(vs).map(v=>[v.id,v])), stock:new Map(Object.values(ss).map(s=>[s.id,s]))};
    REG.stockListo=true; recalcular();
  }catch(e){}
}
let AGG={};
function recalcular(){
  const a={}; const hoy=diaISO(new Date());
  Object.values(STK).forEach(x=>Object.entries(x.agg).forEach(([c,q])=>a[c]=(a[c]||0)+q));
  // Hoy: nube + lo de esta compu que todavía no subió + ventas de otras cajas recibidas por la base del artifact.
  const vh=new Map(STK_HOY.ventas);
  ventas.forEach(v=>{ if(v&&v.id&&diaDe(v)===hoy&&!vh.has(v.id)) vh.set(v.id,v); });
  (window.__vn||[]).forEach(v=>{ if(v&&v.id&&!vh.has(v.id)) vh.set(v.id,v); });
  vh.forEach(v=>aggVenta(a,v));
  const sh=new Map(STK_HOY.stock); (REG.stockLocal||[]).forEach(s=>{ if(diaDe(s)===hoy && !sh.has(s.id)) sh.set(s.id,s); });
  sh.forEach(s=>{ if(!s.anulado) sumarItems(a,s.items,1); });
  AGG=a; try{ renderProds&&renderProds(); }catch(e){}
}
REG.stockLocal = ls("cajaStockLocal", []);
REG.registrarStock = function(mov){
  mov.id = mov.id || cajaSlug()+"-"+MAQ+"-stk-"+Date.now()+"-"+Math.random().toString(36).slice(2,5);
  mov.dia = mov.dia || diaISO(new Date()); mov.ts = mov.ts || Date.now(); mov.caja = mov.caja || $("caja").value; mov.maq = MAQ;
  REG.stockLocal.push(mov); REG.stockLocal = REG.stockLocal.filter(s=>s.dia>=diaISO(Date.now()-7*864e5)); lsW("cajaStockLocal", REG.stockLocal);
  encolar("stock", mov); recalcular(); return mov;
};
REG.actualizarStock = actualizarStock;
// Reemplaza el cálculo de stock de la caja (antes: stock.json − ventas de esta compu y las de hoy).
stockDe = function(p){
  if(!p||STOCK.s[p.cod]==null && AGG[p.cod]==null) return null;
  const n = (+STOCK.s[p.cod]||0) + (AGG[p.cod]||0);
  return Math.round(n*100)/100;
};
setTimeout(actualizarStock, 4000); setInterval(actualizarStock, 3*60*1000);
setInterval(recalcular, 30000);

// ---------- Indicador en pantalla ----------
function usoLocal(){ let t=0; try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); t+=k.length+(localStorage.getItem(k)||"").length; } }catch(e){} return t*2; }
function pintar(){
  let el=$("regEst");
  if(!el){ const h=$("nubeEst"); el=document.createElement("span"); el.id="regEst"; el.style.cssText="font-size:12px;margin-left:8px;cursor:pointer"; el.title="Registro en la nube (Firebase). Tocá para controlar ahora."; el.addEventListener("click",()=>{ controlar(); enviar(); aviso(REG.resumen()); });
    (h&&h.parentNode ? h.parentNode.insertBefore(el,h.nextSibling) : document.body.appendChild(el)); }
  const mb=usoLocal()/1048576, lleno=mb>4.2||REG.errorEspacio;
  const ok=!COLA.length && !REG.ultimoError;
  el.textContent = lleno ? `⚠ Memoria de esta compu casi llena (${mb.toFixed(1)} MB): avisar a Gustavo` : ok ? "Registro nube ✓" : `Registro nube: ${COLA.length} por subir`;
  el.style.color = (ok&&!lleno) ? "var(--accent)" : "var(--off)";
}
REG.resumen = ()=>`Por subir: ${COLA.length}. ${REG.ultimoError?"Error: "+REG.ultimoError+". ":""}Último control: ${REG.control.t?new Date(REG.control.t).toLocaleTimeString("es-AR"):"todavía no"} (${REG.control.dias} días revisados, faltaban ${REG.control.faltaban}).`;
REG.cola = ()=>COLA.slice();
setTimeout(pintar, 1000); setInterval(pintar, 20000);
})();
