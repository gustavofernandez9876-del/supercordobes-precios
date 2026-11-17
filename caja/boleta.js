// =====================================================================================
// CARGAR BOLETA / REMITO  —  caja/boleta.js   (solo con la clave de Gustavo)
// Foto → lectura → tabla editable → controles → okay → precio + stock + alta + etiquetas 5 cm.
// Reglas: CLAUDE.md y coeficientes.json (coeficientes FINALES, redondeo a $50, 25 y 75 suben).
// Todo queda registrado en la nube: movimiento de stock (dias/<d>/stock), comprobante
// (dias/<d>/boletas + boletas/<clave> para detectar duplicados), precios y altas (prod/<cod>).
// También: Ajuste de stock (rotura, vencido, diferencia de conteo) con motivo.
// =====================================================================================
(function(){
"use strict";
const FBU = p=>`${FB_URL}/${FB_K}/${p}.json`;
const nrm = s=>String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9& ]+/g," ").replace(/\s+/g," ").trim();
const sl = s=>nrm(s).replace(/[^a-z0-9]+/g,"");
const num = v=>{ if(v===""||v==null) return null; const x=+String(v).replace(",","."); return isFinite(x)?x:null; };
const r2 = x=>Math.round(x*100)/100;
// Redondeo de Gustavo: múltiplo de $50 más cercano; resto 25 y 75 suben.
const redondeo50 = x=>Math.floor(x/50 + 0.5 + 1e-9)*50;
window.__redondeo50 = redondeo50;

let COEF=null; fetch("coeficientes.json").then(r=>r.ok?r.json():null).then(j=>{ COEF=j; }).catch(()=>{});
let SAMP=null; try{ window.claude?.use?.("sample").then(x=>{ SAMP=x; }).catch(()=>{}); }catch(e){}
let EQUIV={}; // equivalencias código del proveedor → código nuestro, por proveedor
const B = {usuario:null, filas:[], cab:{}, prov:null};

// ---------- Proveedor y reglas ----------
function buscarProveedor(nombre, tipo){
  if(!COEF||!nombre) return null; const n=nrm(nombre); if(!n) return null;
  const nombres=p=>[p.proveedor].concat(p.alias||[]).map(nrm).filter(Boolean);
  const pal=n.split(" ").filter(w=>w.length>=4 && !/^(distribuciones|distribuidora|dist|srl|sas|s a|sociedad)$/.test(w));
  let cands=COEF.proveedores.filter(p=>nombres(p).some(x=>x.includes(n)||n.includes(x)||pal.some(w=>x.includes(w))));
  if(!cands.length) return null;
  const esA=tipo==="Factura A";
  const ok=p=>{ const c=nrm(p.comprobante||""); if(!c) return 1; if(esA) return /(^| )a( |$)/.test(c)?2:0; return /b|remito/.test(c)?2:0; };
  cands=cands.map(p=>[ok(p),p]).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]).map(x=>x[1]);
  return cands[0]||null;
}
function reglaPara(prov, desc){
  if(!prov) return null; const d=nrm(desc);
  for(const r of prov.reglas||[]){ if((r.items||[]).some(it=>it!=="*" && d.includes(nrm(it)))) return r; }
  return (prov.reglas||[]).find(r=>(r.items||[]).includes("*"))||null;
}
// Costo unitario según la base del proveedor (ver COEFICIENTES.md).
function costoUnit(f, base){
  const cant=num(f.cant)||0, bon=num(f.bonif)||0, xb=num(f.xb)||1, unid=(cant+bon)*xb;
  if(!unid) return null;
  const tot=num(f.total), pu=num(f.pu), dto=num(f.dto)||0, pun=num(f.pun), fu=num(f.fu);
  const porTotal = tot!=null ? tot/unid : null;
  const porPU = (p)=> p!=null ? p*cant/(cant+bon)/xb : null;
  switch(base){
    case "TOTAL_RENGLON": case "SUBTOTAL_UNID": return porTotal ?? porPU(pu!=null?pu*(1-dto/100):null);
    case "FINAL_UNIT": return fu!=null ? fu/xb : porTotal;
    case "PU_NETO": return porPU(pun!=null?pun:(pu!=null?pu*(1-dto/100):null)) ?? porTotal;
    default: return porPU(pu!=null?pu*(1-dto/100):null) ?? porTotal;
  }
}
function soloStockProd(p){ return p && (p.cig || p.fv || p.kg || /COCA/i.test(p.desc||"") && B.prov && /dico/i.test(B.prov.proveedor)); }

// ---------- Recalcular una fila ----------
function calcFila(f){
  const p = f.cod ? porCodigo(f.cod) : null;
  f.prodDesc = p ? p.desc : (f.alta ? "ALTA NUEVA" : "");
  f.precioAct = p ? (+p.precio||0) : null;
  const base = B.prov ? B.prov.base : "PRECIO_REMITO";
  if(!f.costoManual){ const c=costoUnit(f, base); f.costo = c!=null ? r2(c) : null; }
  if(!f.coefManual){ const rg=reglaPara(B.prov, f.desc); f.coef = rg?rg.coef:null; f.extra = rg&&rg.extra?rg.extra:0; }
  const soloStock = (B.prov && B.prov.base==="SOLO_STOCK") || soloStockProd(p);
  if(soloStock && f.accion==="precio") f.accion="stock";
  if(!f.precioManual) f.precio = (f.costo!=null && f.coef) ? redondeo50(f.costo*f.coef + (+f.extra||0)) : null;
  f.unid = r2(((num(f.cant)||0)+(num(f.bonif)||0))*(num(f.xb)||1));
  f.problema = "";
  if(f.accion==="no") return f;
  if(!f.cod && !f.alta) f.problema="Elegí el producto o marcá ALTA";
  else if(f.alta && !String(f.desc||"").trim()) f.problema="Falta la descripción para el alta";
  else if(!(f.unid>0)) f.problema="Cantidad en cero";
  else if(f.accion==="precio" && !f.coef && !f.precioManual) f.problema="PREGUNTAR coeficiente";
  else if(f.accion==="precio" && !(f.precio>0)) f.problema="Sin precio";
  return f;
}
function porCodigo(c){ c=String(c||"").trim(); if(!c) return null; return PRODUCTOS.find(p=>p.cod===c) || (typeof buscar==="function"?buscar(c):null); }
function sugerencias(desc){
  const toks=nrm(desc).split(" ").filter(w=>w.length>=3); if(!toks.length) return [];
  return PRODUCTOS.filter(p=>!p.inactivo).map(p=>{ const h=p._h||nrm(p.desc); const s=toks.filter(t=>h.includes(t)).length/toks.length; return [s,p]; })
    .filter(x=>x[0]>=0.5).sort((a,b)=>b[0]-a[0]).slice(0,5).map(x=>x[1]);
}
function asociar(f){
  if(f.cod) return;
  const prov=sl(B.cab.prov), eq=(EQUIV[prov]||{});
  if(f.codProv && eq[sl(f.codProv)]){ f.cod=eq[sl(f.codProv)]; f.como="equivalencia"; return; }
  if(f.ean){ const p=porCodigo(f.ean); if(p){ f.cod=p.cod; f.como="código de barras"; return; } }
  if(f.codProv){ const p=PRODUCTOS.find(x=>x.cod===f.codProv); if(p && sugerencias(f.desc).includes(p)){ f.cod=p.cod; f.como="código"; return; } }
  f.sug = sugerencias(f.desc).map(p=>p.cod);
}

// ---------- Interfaz ----------
const css = `#bolModal .ticket{max-width:1200px;width:100%;max-height:94vh;overflow:auto}
#bolTb{width:100%;border-collapse:collapse;font-size:13px} #bolTb th{background:var(--soft,#f2f2f2);position:sticky;top:0;text-align:left;padding:4px;font-weight:600}
#bolTb td{border-top:1px solid var(--line,#ddd);padding:3px;vertical-align:top} #bolTb input{width:100%;box-sizing:border-box;padding:3px;font:inherit}
#bolTb input.n{text-align:right} #bolTb tr.mal td{background:rgba(220,40,40,.08)} #bolTb tr.no td{opacity:.45}
.bolChip{display:inline-block;border:1px solid var(--line,#ccc);border-radius:10px;padding:1px 6px;margin:2px 2px 0 0;font-size:11px;cursor:pointer;background:transparent}
.bolProb{color:var(--off,#c00);font-weight:600;font-size:12px} .bolOk{color:var(--accent,#080);font-size:12px}
#bolTot{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0;font-size:14px} .bolTabs button[aria-pressed=true]{font-weight:700;text-decoration:underline}`;
function armar(){
  if($("bolModal")) return;
  const st=document.createElement("style"); st.textContent=css; document.head.appendChild(st);
  const m=document.createElement("div"); m.className="modal"; m.id="bolModal"; m.hidden=true;
  m.innerHTML=`<div class="ticket ci" role="dialog" aria-labelledby="bolTit">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3 id="bolTit">Cargar boleta / remito</h3><button class="del" id="bolX" type="button" aria-label="Cerrar">×</button></div>
  <div id="bolLogin"><div class="hint">Solo Gustavo. Escribí tu clave (se pide siempre, aunque el dispositivo sea de confianza).</div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="bolPin" type="password" autocomplete="off" placeholder="Clave de Gustavo"><button class="btn primary" id="bolEntrar" type="button">Entrar</button></div></div>
  <div id="bolMain" hidden>
    <div class="bolTabs" style="display:flex;gap:10px;margin:6px 0"><button class="btn" type="button" data-bt="carga" aria-pressed="true">Boleta / remito</button><button class="btn" type="button" data-bt="ajuste" aria-pressed="false">Ajuste de stock</button><button class="btn" type="button" data-bt="hist" aria-pressed="false">Cargadas</button></div>
    <div id="bolCarga">
      <div class="cigrid">
        <label for="bolTipo">Comprobante</label><select id="bolTipo"><option>Factura A</option><option>Factura B</option><option>Remito</option></select>
        <label for="bolProv">Proveedor o persona que trae</label><input id="bolProv" list="bolProvL" placeholder="Ej. DELINTER o el nombre de quien trae"><datalist id="bolProvL"></datalist>
        <label for="bolNro">Número</label><input id="bolNro" placeholder="0001-00012345 (en remitos sin número: fecha y nombre)">
        <label for="bolFecha">Fecha</label><input id="bolFecha" type="date">
        <label for="bolTotal">Total del comprobante</label><input id="bolTotal" type="number" step="any" min="0">
        <label for="bolFoto">Foto(s) de la boleta</label><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input id="bolFoto" type="file" accept="image/*" capture="environment" multiple><button class="btn" id="bolLeer" type="button">Leer foto</button><span id="bolLeerEst" class="hint"></span></span>
      </div>
      <div id="bolProvInfo" class="hint" style="margin:6px 0"></div>
      <div style="overflow:auto"><table id="bolTb"><thead><tr><th style="width:22%">Producto en el sistema</th><th style="width:20%">Descripción en la boleta</th><th>Cant.</th><th>Bonif.</th><th>U/bulto</th><th>P. unit.</th><th>Dto %</th><th>Total renglón</th><th>Costo u.</th><th>Coef.</th><th>Precio nuevo</th><th>Actual</th><th>Qué hacer</th></tr></thead><tbody></tbody></table></div>
      <button class="btn" id="bolAgregar" type="button" style="margin-top:6px">+ Agregar renglón</button>
      <div id="bolTot"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="bolGrabar" type="button">Grabar (precio + stock + altas)</button><button class="btn" id="bolLimpiar" type="button">Empezar de nuevo</button></div>
      <div id="bolRes" style="margin-top:10px"></div>
    </div>
    <div id="bolAjuste" hidden>
      <div class="hint">Para rotura, vencido, robo o diferencia de conteo. Positivo suma, negativo resta. Queda registrado con motivo y con tu nombre.</div>
      <div class="cigrid" style="margin-top:6px">
        <label for="ajCod">Código o código de barras</label><input id="ajCod"><span></span><span id="ajDesc" class="hint"></span>
        <label for="ajQ">Cantidad (+ o −)</label><input id="ajQ" type="number" step="any">
        <label for="ajMot">Motivo</label><select id="ajMot"><option>Rotura</option><option>Vencido</option><option>Diferencia de conteo</option><option>Robo / faltante</option><option>Devolución a proveedor</option><option>Otro</option></select>
        <label for="ajObs">Detalle</label><input id="ajObs">
        <span></span><button class="btn primary" id="ajGrabar" type="button">Grabar ajuste</button>
      </div>
    </div>
    <div id="bolHist" hidden><div id="bolHistL" class="hist"></div></div>
  </div></div>`;
  document.body.appendChild(m);
  // Botón en la barra de arriba
  const b=document.createElement("button"); b.className="btn"; b.id="btnBoleta"; b.type="button"; b.textContent="Cargar boleta / remito";
  const ref=$("btnCompA"); if(ref&&ref.parentNode) ref.parentNode.insertBefore(b, ref); else document.body.appendChild(b);
  b.addEventListener("click", abrir);
  $("bolX").addEventListener("click", ()=>{ m.hidden=true; B.usuario=null; try{$("scan").focus();}catch(e){} });
  $("bolEntrar").addEventListener("click", entrar); $("bolPin").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); entrar(); } });
  m.querySelector(".bolTabs").addEventListener("click", e=>{ const t=e.target.closest("[data-bt]"); if(!t) return; m.querySelectorAll("[data-bt]").forEach(x=>x.setAttribute("aria-pressed", x===t)); $("bolCarga").hidden=t.dataset.bt!=="carga"; $("bolAjuste").hidden=t.dataset.bt!=="ajuste"; $("bolHist").hidden=t.dataset.bt!=="hist"; if(t.dataset.bt==="hist") historial(); });
  ["bolTipo","bolProv"].forEach(id=>$(id).addEventListener("change", ()=>{ B.cab.prov=$("bolProv").value.trim(); B.cab.tipo=$("bolTipo").value; elegirProv(); }));
  $("bolTotal").addEventListener("input", totales);
  $("bolAgregar").addEventListener("click", ()=>{ B.filas.push(nuevaFila({})); pintar(); });
  $("bolLimpiar").addEventListener("click", ()=>{ if(B.filas.length && !confirm("¿Borrar la tabla y empezar de nuevo?")) return; limpiar(); });
  $("bolLeer").addEventListener("click", leerFoto);
  $("bolGrabar").addEventListener("click", grabar);
  $("bolTb").addEventListener("input", editar); $("bolTb").addEventListener("change", editar); $("bolTb").addEventListener("click", clickTabla);
  $("ajCod").addEventListener("input", ()=>{ const p=porCodigo($("ajCod").value); $("ajDesc").textContent = p ? p.desc+" · stock "+(stockDe(p)??"sin dato") : ""; });
  $("ajGrabar").addEventListener("click", grabarAjuste);
}
function abrir(){ armar(); $("bolModal").hidden=false; if(B.usuario){ $("bolLogin").hidden=true; $("bolMain").hidden=false; } else { $("bolLogin").hidden=false; $("bolMain").hidden=true; $("bolPin").value=""; setTimeout(()=>$("bolPin").focus(),50); } }
async function entrar(){
  const t=$("bolPin").value; $("bolPin").value="";
  const h = await huella(t); const u = normClave(t) ? AUTORIZADOS.find(x=>x.hash===h) : null;
  if(!u){ try{ registrarIntento("Cargar boleta / remito"); }catch(e){} aviso("Clave incorrecta. Solo Gustavo puede cargar boletas. El intento queda registrado."); return; }
  B.usuario=u.nombre; $("bolLogin").hidden=true; $("bolMain").hidden=false;
  if(!$("bolFecha").value) $("bolFecha").value=diaISO(new Date());
  const nom=new Set(); (typeof PROVEEDORES!=="undefined"?PROVEEDORES:[]).forEach(p=>nom.add(p[0])); (COEF?COEF.proveedores:[]).forEach(p=>nom.add(p.proveedor));
  $("bolProvL").innerHTML=[...nom].sort().map(n=>`<option value="${escH(n)}">`).join("");
  cargarEquiv(); pintar();
}
function limpiar(){ B.filas=[]; B.cab={}; B.prov=null; ["bolProv","bolNro","bolTotal"].forEach(id=>$(id).value=""); $("bolFoto").value=""; $("bolFecha").value=diaISO(new Date()); $("bolRes").innerHTML=""; $("bolLeerEst").textContent=""; elegirProv(); pintar(); }
function elegirProv(){
  B.cab.tipo=$("bolTipo").value; B.cab.prov=$("bolProv").value.trim();
  B.prov = buscarProveedor(B.cab.prov, B.cab.tipo);
  const i=$("bolProvInfo");
  if(!B.cab.prov) i.innerHTML="";
  else if(!B.prov) i.innerHTML=`<span class="bolProb">Sin coeficientes cargados para "${escH(B.cab.prov)}"${B.cab.tipo==="Remito"?" (remito)":""}: poné el coeficiente de cada renglón a mano o marcá "solo stock".</span>`;
  else i.innerHTML=`Reglas de <b>${escH(B.prov.proveedor)}</b>${B.prov.comprobante?" ("+escH(B.prov.comprobante)+")":""} · base: <b>${escH((COEF.bases||{})[B.prov.base]||B.prov.base)}</b> · ${(B.prov.reglas||[]).map(r=>escH(r.items.join(", "))+" <b>"+String(r.coef).replace(".",",")+(r.extra?" + $"+r.extra:"")+"</b>").join(" · ")}${B.prov.notas?"<br>Nota: "+escH(B.prov.notas):""}`;
  B.filas.forEach(f=>{ asociar(f); calcFila(f); }); pintar();
}
function nuevaFila(x){ return calcFila(Object.assign({desc:"",codProv:"",ean:"",cant:"",bonif:"",xb:1,pu:"",dto:"",pun:"",total:"",fu:"",cod:"",alta:false,accion:"precio",coef:null,extra:0},x)); }
const fN = v=>v==null||v===""?"":String(v);
function pintar(){
  const tb=$("bolTb").tBodies[0]; if(!tb) return;
  tb.innerHTML = B.filas.map((f,i)=>{
    const sug=(f.sug||[]).map(c=>{ const p=porCodigo(c); return p?`<button type="button" class="bolChip" data-sug="${i}" data-cod="${escH(p.cod)}" title="${escH(p.desc)}">${escH(p.desc.slice(0,28))}</button>`:""; }).join("");
    return `<tr data-i="${i}" class="${f.accion==="no"?"no":f.problema?"mal":""}">
    <td><input data-k="cod" value="${escH(f.cod)}" placeholder="código / barras">
      <div class="${f.cod?"bolOk":"bolProb"}">${escH(f.prodDesc||(f.alta?"":"sin elegir"))}${f.como?` <small>(${escH(f.como)})</small>`:""}</div>
      ${f.cod?"":`<label style="font-size:12px"><input type="checkbox" data-k="alta" ${f.alta?"checked":""} style="width:auto"> ALTA nueva</label>`}
      ${f.cod?"":sug}</td>
    <td><input data-k="desc" value="${escH(f.desc)}">${f.codProv?`<small>cód. prov. ${escH(f.codProv)}</small>`:""}${f.ean?` <small>EAN ${escH(f.ean)}</small>`:""}</td>
    <td><input class="n" data-k="cant" value="${fN(f.cant)}" inputmode="decimal"></td>
    <td><input class="n" data-k="bonif" value="${fN(f.bonif)}" inputmode="decimal"></td>
    <td><input class="n" data-k="xb" value="${fN(f.xb)}" inputmode="decimal"></td>
    <td><input class="n" data-k="pu" value="${fN(f.pu)}" inputmode="decimal"></td>
    <td><input class="n" data-k="dto" value="${fN(f.dto)}" inputmode="decimal"></td>
    <td><input class="n" data-k="total" value="${fN(f.total)}" inputmode="decimal"></td>
    <td><input class="n" data-k="costo" value="${fN(f.costo)}" inputmode="decimal" title="Costo por unidad: ${escH(B.prov?B.prov.base:"PRECIO_REMITO")}"></td>
    <td><input class="n" data-k="coef" value="${fN(f.coef)}" inputmode="decimal" style="${f.coef?"":"outline:2px solid var(--off,#c00)"}"></td>
    <td><input class="n" data-k="precio" value="${fN(f.precio)}" inputmode="decimal"></td>
    <td class="num" style="text-align:right">${f.precioAct!=null?fmt(f.precioAct):"—"}${f.precioAct&&f.precio?`<br><small>${f.precio>f.precioAct?"▲":f.precio<f.precioAct?"▼":"="} ${Math.round((f.precio/f.precioAct-1)*100)}%</small>`:""}</td>
    <td><select data-k="accion"><option value="precio" ${f.accion==="precio"?"selected":""}>Precio + stock</option><option value="stock" ${f.accion==="stock"?"selected":""}>Solo stock</option><option value="no" ${f.accion==="no"?"selected":""}>No cargar</option></select>
      <div style="font-size:12px">${f.unid?"+"+f.unid+" u.":""}</div>${f.problema?`<div class="bolProb">${escH(f.problema)}</div>`:""}</td></tr>`; }).join("") || `<tr><td colspan="13" class="empty">Sacá la foto y tocá "Leer foto", o agregá los renglones a mano.</td></tr>`;
  totales();
}
function totales(){
  const suma=r2(B.filas.filter(f=>f.accion!=="no"||true).reduce((a,f)=>a+(num(f.total)||0),0));
  const tot=num($("bolTotal").value), dif=tot!=null?r2(tot-suma):null;
  const mal=B.filas.filter(f=>f.accion!=="no"&&f.problema).length, no=B.filas.filter(f=>f.accion==="no").length;
  $("bolTot").innerHTML=`<span>Renglones: <b>${B.filas.length}</b></span><span>Suma de renglones: <b>${fmt(suma)}</b></span><span>Total comprobante: <b>${tot!=null?fmt(tot):"—"}</b></span>`+
    (dif==null?`<span class="bolProb">Cargá el total del comprobante</span>`:Math.abs(dif)<=1?`<span class="bolOk">✓ coincide</span>`:`<span class="bolProb">Diferencia ${fmt(dif)} (percepciones, impuestos o un renglón mal leído: revisalo)</span>`)+
    (mal?`<span class="bolProb">${mal} renglón(es) con problema</span>`:"")+(no?`<span>${no} sin cargar</span>`:"");
  return {suma,tot,dif,mal};
}
function editar(e){
  const el=e.target, tr=el.closest("tr[data-i]"); if(!tr||!el.dataset.k) return; const f=B.filas[+tr.dataset.i]; const k=el.dataset.k;
  if(e.type==="input" && el.tagName==="SELECT") return;
  if(k==="alta"){ f.alta=el.checked; }
  else if(k==="accion"){ f.accion=el.value; }
  else { f[k]=el.value; if(k==="costo") f.costoManual=el.value!==""; if(k==="coef") f.coefManual=el.value!==""; if(k==="precio") f.precioManual=el.value!=="";
    if(k==="cod"){ f.como=""; if(e.type!=="change") return; const p=porCodigo(el.value); if(p){ f.cod=p.cod; f.alta=false; } } }
  if(["cant","bonif","xb","pu","dto","total"].includes(k)) f.costoManual=false, f.precioManual=false;
  if(["costo","coef"].includes(k)) f.precioManual=false;
  if(k==="desc" && !f.coefManual){ /* recalcula la regla por descripción */ }
  calcFila(f);
  if(e.type==="change"||k==="alta"||k==="accion") pintar(); else { totales(); const pr=tr.querySelector('[data-k="precio"]'); if(pr && document.activeElement!==pr) pr.value=fN(f.precio); }
}
function clickTabla(e){ const b=e.target.closest("[data-sug]"); if(!b) return; const f=B.filas[+b.dataset.sug]; f.cod=b.dataset.cod; f.alta=false; f.como="elegido"; calcFila(f); pintar(); }

// ---------- Lectura de la foto ----------
async function leerFoto(){
  const fs=[...($("bolFoto").files||[])]; if(!fs.length){ aviso("Primero elegí o sacá la foto de la boleta."); return; }
  if(!SAMP){ aviso("En esta caja no está disponible la lectura de fotos: cargá los renglones a mano."); return; }
  $("bolLeerEst").textContent="Leyendo la boleta… (puede tardar un minuto)";
  const prompt=`Sos un asistente que transcribe comprobantes de compra de un supermercado de Argentina (facturas A/B y remitos). Las fotos son hojas del MISMO comprobante, en orden.
Transcribí EXACTAMENTE lo impreso, sin calcular nada ni inventar. Números en formato JSON (punto decimal; "1.234,50" impreso = 1234.5).
Respondé SOLO este JSON:
{"proveedor":"razón social del emisor","cuit":"","tipo":"Factura A|Factura B|Remito","numero":"0001-00012345","fecha":"AAAA-MM-DD","total":0,
 "renglones":[{"codigo":"código del proveedor si figura","ean":"código de barras si figura","descripcion":"","cantidad":0,"bonificadas":0,"unidades_por_bulto":1,"precio_unitario":0,"descuento_pct":0,"precio_unitario_neto":null,"total_renglon":0,"final_unit":null}]}
Reglas: un objeto por renglón de producto (no incluyas subtotales, IVA, percepciones ni totales como renglones). "bonificadas" son unidades sin cargo de ese renglón (0 si no hay). Si la cantidad viene en bultos y el bulto trae varias unidades, poné "unidades_por_bulto". "precio_unitario_neto" solo si hay una columna de unitario neto o con descuento aplicado. "final_unit" solo si hay una columna FINAL UNIT. Si un dato no se lee, null.`;
  try{
    const j = await SAMP.json(prompt, {images: fs});
    if(!j || !Array.isArray(j.renglones)) throw new Error("respuesta sin renglones");
    if(j.proveedor && !$("bolProv").value) $("bolProv").value=j.proveedor;
    if(j.tipo && /^(Factura A|Factura B|Remito)$/.test(j.tipo)) $("bolTipo").value=j.tipo;
    if(j.numero && !$("bolNro").value) $("bolNro").value=j.numero;
    if(j.fecha && /^\d{4}-\d{2}-\d{2}$/.test(j.fecha)) $("bolFecha").value=j.fecha;
    if(j.total!=null && !$("bolTotal").value) $("bolTotal").value=j.total;
    B.cab.cuit = String(j.cuit||"").replace(/\D/g,"");
    B.filas = j.renglones.map(r=>nuevaFila({desc:r.descripcion||"", codProv:r.codigo||"", ean:String(r.ean||"").replace(/\D/g,""), cant:r.cantidad??"", bonif:r.bonificadas||"", xb:r.unidades_por_bulto||1, pu:r.precio_unitario??"", dto:r.descuento_pct||"", pun:r.precio_unitario_neto??"", total:r.total_renglon??"", fu:r.final_unit??"", leido:true}));
    elegirProv();
    $("bolLeerEst").textContent=`Leídos ${B.filas.length} renglones. REVISÁ cada uno contra la boleta antes de grabar.`;
  }catch(e){ $("bolLeerEst").textContent="No se pudo leer: "+(e.message||e)+". Cargá a mano o probá con otra foto."; }
}

// ---------- Equivalencias código proveedor → nuestro ----------
async function cargarEquiv(){ try{ const r=await fetch(FBU("equiv")); if(r.ok) EQUIV=(await r.json())||{}; }catch(e){} }

// ---------- Grabar ----------
async function grabar(){
  elegirProv();
  const c={tipo:$("bolTipo").value, prov:$("bolProv").value.trim().toUpperCase(), nro:$("bolNro").value.trim(), fecha:$("bolFecha").value};
  if(!c.prov){ aviso("Falta el proveedor o la persona que trae la mercadería."); return; }
  if(!c.nro){ aviso("Falta el número del comprobante (en un remito sin número poné la fecha y el nombre)."); return; }
  if(!B.filas.length){ aviso("No hay renglones."); return; }
  const t=totales();
  const malas=B.filas.filter(f=>f.accion!=="no"&&f.problema);
  if(malas.length){ aviso(`Hay ${malas.length} renglón(es) con problema (en rojo). Corregilos o marcá "No cargar".`); return; }
  if(t.tot==null){ aviso("Cargá el total del comprobante para controlar la suma."); return; }
  if(Math.abs(t.dif)>1 && !confirm(`La suma de renglones (${fmt(t.suma)}) no coincide con el total (${fmt(t.tot)}): diferencia ${fmt(t.dif)}.\n¿Grabar igual? (queda anotada la diferencia)`)) return;
  const clave=sl(c.prov)+"_"+sl(c.nro);
  // Duplicados: proveedor + número, en la nube y en esta compu.
  try{ const r=await fetch(FBU("boletas/"+clave)); if(!r.ok) throw new Error("sin conexión con la nube ("+r.status+")"); const ya=await r.json();
    if(ya){ aviso(`Esta boleta YA está cargada (${ya.prov} ${ya.nro}, el ${ya.cargada||ya.fecha} por ${ya.usuario}). No se suma stock de nuevo.`); return; } }
  catch(e){ aviso("No se pudo controlar si la boleta ya está cargada: "+(e.message||e)+". Probá de nuevo con internet."); return; }
  const ok=B.filas.filter(f=>f.accion!=="no"), no=B.filas.filter(f=>f.accion==="no");
  const cambiosPrecio=ok.filter(f=>f.accion==="precio" && (f.alta || f.precio!==f.precioAct)).length;
  if(!confirm(`Grabar ${c.tipo} ${c.prov} ${c.nro}:\n· ${ok.length} renglones a stock\n· ${cambiosPrecio} precios nuevos o cambiados\n· ${ok.filter(f=>f.alta).length} altas\n· ${no.length} sin cargar\n¿Confirmás?`)) return;
  const ahora=new Date(), fechaTxt=ahora.toLocaleString("es-AR"), ref=`${c.tipo} ${c.prov} ${c.nro}`;
  const items=[], etiquetas=[], resumen=[];
  for(const f of ok){
    let cod=f.cod;
    if(f.alta){
      cod="N"+Date.now().toString().slice(-7)+Math.floor(Math.random()*10);
      const datos={desc:String(f.desc).trim().toUpperCase(), bc:/^\d{8,14}$/.test(f.ean||"")&&ean13ok(f.ean)?f.ean:"", rubro:"", marca:"", empresa:c.prov, precio:f.accion==="precio"?f.precio:0, efe:true, fv:false, inactivo:false};
      prodEdits[cod]={nuevo:true, datos, hist:[{fecha:fechaTxt,user:B.usuario,campo:"Alta",antes:"(alta)",despues:"desde "+ref}], ts:Date.now()};
      if(f.accion==="precio") etiquetas.push({desc:datos.desc, precio:datos.precio, bc:datos.bc, cod});
    } else if(f.accion==="precio" && f.precio!==f.precioAct){
      const p=porCodigo(cod); const e0=prodEdits[cod]||{nuevo:false,datos:{},hist:[]};
      e0.datos.precio=f.precio; e0.hist=(e0.hist||[]).concat([{fecha:fechaTxt,user:B.usuario,campo:"Precio",antes:fmt(f.precioAct||0),despues:fmt(f.precio)+" ("+ref+")"}]); e0.ts=Date.now();
      prodEdits[cod]=e0; etiquetas.push({desc:p?p.desc:f.desc, precio:f.precio, bc:p?p.bc:"", cod});
    }
    items.push({cod, q:f.unid, desc:f.desc, costo:f.costo, coef:f.coef, precio:f.accion==="precio"?f.precio:null, accion:f.accion, alta:!!f.alta});
    resumen.push(f);
    if(f.codProv && !f.alta){ const pv=sl(c.prov); (EQUIV[pv]=EQUIV[pv]||{})[sl(f.codProv)]=cod; }
  }
  lsSet("cajaProdEdits", prodEdits); try{ aplicarEditsProd(); indexar(); }catch(e){}
  const mov=REG.registrarStock({tipo:c.tipo==="Remito"?"entrada remito":"entrada boleta", comprobante:c.tipo, origen:c.prov, nro:c.nro, fechaComp:c.fecha, boleta:clave, usuario:B.usuario, items});
  const rec={id:clave, clave, tipo:c.tipo, prov:c.prov, cuit:B.cab.cuit||"", nro:c.nro, fecha:c.fecha, total:t.tot, suma:t.suma, diferencia:t.dif, usuario:B.usuario, cargada:fechaTxt, dia:diaISO(ahora), ts:Date.now(), caja:$("caja").value, stock:mov.id,
    renglones:B.filas.map(f=>({desc:f.desc, codProv:f.codProv, ean:f.ean, cant:f.cant, bonif:f.bonif, xb:f.xb, pu:f.pu, dto:f.dto, total:f.total, costo:f.costo, coef:f.coef, precio:f.precio, precioAnterior:f.precioAct, cod:f.cod||null, alta:!!f.alta, accion:f.accion})),
    noCargados:no.map(f=>f.desc)};
  REG.encolar("boletas", rec);
  try{ await fetch(FBU("boletas/"+clave),{method:"PUT",body:JSON.stringify(rec)}); }catch(e){}
  try{ await fetch(FBU("equiv"),{method:"PATCH",body:JSON.stringify(EQUIV)}); }catch(e){}
  REG.subirProductos(); try{ render(); }catch(e){}
  const hist=lsGet("cajaBoletas",[]); hist.push({clave,prov:c.prov,nro:c.nro,tipo:c.tipo,fecha:c.fecha,total:t.tot,cargada:fechaTxt,renglones:ok.length}); lsSet("cajaBoletas",hist.slice(-200));
  B.ultimasEtiquetas=etiquetas;
  $("bolRes").innerHTML=`<div class="bolOk" style="font-size:15px">✓ Grabada: ${escH(ref)} · ${ok.length} renglones a stock · ${etiquetas.length} precios nuevos o cambiados.</div>`+
    (no.length?`<div class="bolProb" style="margin-top:6px">NO quedaron cargados (${no.length}):</div><ul>${no.map(f=>`<li>${escH(f.desc||"(sin descripción)")}${f.total?" · "+fmt(+f.total):""}</li>`).join("")}</ul>`:`<div class="bolOk">Todos los renglones quedaron cargados.</div>`)+
    (etiquetas.length?`<button class="btn primary" type="button" id="bolEtiq">Imprimir ${etiquetas.length} etiqueta(s) de 5 cm</button>`:"");
  const be=$("bolEtiq"); if(be) be.addEventListener("click",()=>imprimirEtiquetas(B.ultimasEtiquetas));
  B.filas=[]; pintar(); ["bolNro","bolTotal"].forEach(id=>$(id).value=""); $("bolFoto").value="";
  aviso("Boleta grabada y registrada en la nube.");
}

// ---------- Ajuste de stock ----------
function grabarAjuste(){
  const p=porCodigo($("ajCod").value), q=num($("ajQ").value);
  if(!p){ aviso("No encuentro ese producto."); return; } if(!q){ aviso("Poné la cantidad (positiva suma, negativa resta)."); return; }
  if(!confirm(`Ajuste de stock: ${p.desc}\n${q>0?"+":""}${q} por "${$("ajMot").value}". ¿Confirmás?`)) return;
  REG.registrarStock({tipo:"ajuste", motivo:$("ajMot").value, detalle:$("ajObs").value.trim(), usuario:B.usuario, items:[{cod:p.cod, q, desc:p.desc}]});
  aviso("Ajuste registrado en la nube."); ["ajCod","ajQ","ajObs"].forEach(id=>$(id).value=""); $("ajDesc").textContent="";
}
async function historial(){
  const el=$("bolHistL"); el.innerHTML="Buscando en la nube…";
  try{ const r=await fetch(FBU("boletas")); const j=(await r.json())||{};
    const l=Object.values(j).sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,60);
    el.innerHTML=l.map(b=>`<div><span>${escH(b.fecha||"")} · ${escH(b.tipo)} · <b>${escH(b.prov)}</b> · ${escH(b.nro)}<br><small>${(b.renglones||[]).length} renglones · cargada ${escH(b.cargada||"")} por ${escH(b.usuario||"")}${b.noCargados&&b.noCargados.length?" · "+b.noCargados.length+" sin cargar":""}${b.diferencia&&Math.abs(b.diferencia)>1?" · diferencia "+fmt(b.diferencia):""}</small></span><b>${fmt(b.total||0)}</b></div>`).join("")||"<div>Todavía no hay boletas cargadas.</div>";
  }catch(e){ el.innerHTML="No se pudo leer la nube."; }
}

// ---------- Etiquetas de 5 cm ----------
// EAN-13 en SVG (si el producto tiene código de barras válido).
const L=["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G=["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R=["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const PAR=["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
function ean13svg(c){
  if(!/^\d{13}$/.test(c)||!ean13ok(c)) return "";
  let b="101"; const p=PAR[+c[0]];
  for(let i=1;i<=6;i++) b+=(p[i-1]==="L"?L:G)[+c[i]];
  b+="01010"; for(let i=7;i<=12;i++) b+=R[+c[i]]; b+="101";
  let x=0, rects=""; for(const ch of b){ if(ch==="1") rects+=`<rect x="${x}" y="0" width="1" height="40"/>`; x++; }
  return `<svg viewBox="0 0 ${b.length} 40" width="44mm" height="9mm" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}
function imprimirEtiquetas(l){
  if(!l||!l.length){ aviso("No hay etiquetas para imprimir."); return; }
  const ancho = /2/.test($("caja").value||"") ? 80 : 58; // Caja 1: térmica 58 mm · Caja 2: térmica 80 mm
  const e=s=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const h=`<html><head><meta charset="utf-8"><style>@page{size:${ancho}mm auto;margin:0}body{margin:0;font-family:Arial,sans-serif}
  .et{width:50mm;margin:0 auto;padding:2mm 0 3mm;border-bottom:1px dashed #000;page-break-inside:avoid;text-align:center}
  .d{font-size:11px;font-weight:bold;line-height:1.15;max-height:2.4em;overflow:hidden}.p{font-size:26px;font-weight:bold;margin:1mm 0}.c{font-size:9px}</style></head><body>
  ${l.map(x=>`<div class="et"><div class="d">${e(x.desc)}</div><div class="p">$ ${Math.round(x.precio).toLocaleString("es-AR")}</div>${ean13svg(x.bc||"")}<div class="c">${e(x.bc||"")} · cód. ${e(x.cod)} · ${new Date().toLocaleDateString("es-AR")}</div></div>`).join("")}</body></html>`;
  let fr=document.getElementById("printFrame"); if(fr) fr.remove();
  fr=document.createElement("iframe"); fr.id="printFrame"; fr.style.cssText="position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.appendChild(fr); fr.contentDocument.open(); fr.contentDocument.write(h); fr.contentDocument.close();
  setTimeout(()=>{ try{ fr.contentWindow.focus(); fr.contentWindow.print(); }catch(err){ aviso("No se pudo imprimir"); } },250);
}
window.BOLETA={imprimirEtiquetas, ean13svg, costoUnit, buscarProveedor, reglaPara, redondeo50, abrir, B, calcFila, nuevaFila, elegirProv, pintar};
armar();
})();
