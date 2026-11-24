/**
 * PULSO DE OBRA – MILÁN CAMPESTRE · Backend de la app de registro
 * Va pegado dentro de la hoja "Pulso de Obra – Milán – RAW" (Extensiones → Apps Script).
 *
 * GET  ?accion=catalogo  → personal activo, maestros, actividades activas y parámetros (la app lo lee al abrir)
 * GET  ?accion=ping      → prueba de conexión
 * POST {hoja:"Registros", registros:[{...}, ...]}  → agrega filas (sin fórmulas). Mismo formato que la app de AIRPLAN.
 *
 * Reglas:
 * - Solo anota filas crudas; los costos se calculan en el tablero.
 * - Las columnas de código se escriben como texto (evita que 02.01 se vuelva fecha).
 * - No repite un id que ya exista en la hoja (frena registros dobles).
 */

var HOJAS_PERMITIDAS = ['Registros', 'Novedades', 'Cierres'];
var COLUMNAS_TEXTO = ['id', 'codfrente', 'codcap', 'codsubcap', 'codcat', 'codact', 'loteid', 'creado', 'cedula'];

function doGet(e) {
  var accion = (e && e.parameter && e.parameter.accion) || 'catalogo';
  if (accion === 'ping') return salida_({ ok: true, obra: 'Milán Campestre', hora: new Date().toISOString() });
  if (accion === 'catalogo') return salida_(catalogo_());
  return salida_({ ok: false, error: 'Acción no reconocida: ' + accion });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var datos = JSON.parse(e.postData.contents);
    var nombreHoja = datos.hoja || 'Registros';
    if (HOJAS_PERMITIDAS.indexOf(nombreHoja) < 0) throw new Error('Hoja no permitida: ' + nombreHoja);
    var filas = datos.registros || datos.filas || (datos.fila ? [datos.fila] : []);
    if (!filas.length) throw new Error('No llegaron filas');
    var r = agregar_(nombreHoja, filas);
    return salida_({ ok: true, hoja: nombreHoja, agregadas: r.agregadas, repetidas: r.repetidas });
  } catch (err) {
    return salida_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Catálogo que lee la app (mismo formato que catalogo.json de AIRPLAN) ---------- */
var RECARGOS = [
  { tipo: 'Ordinaria Diurna', factor: 1 }, { tipo: 'Recargo Nocturno (Ordinaria)', factor: 1.35 },
  { tipo: 'Extra Diurna', factor: 1.25 }, { tipo: 'Extra Nocturna', factor: 1.75 },
  { tipo: 'Dominical/Festivo Ordinaria Diurna', factor: 1.9 }, { tipo: 'Dominical/Festivo Ordinaria Nocturna', factor: 2.25 },
  { tipo: 'Dominical/Festivo Extra Diurna', factor: 2.15 }, { tipo: 'Dominical/Festivo Extra Nocturna', factor: 2.65 }
];
function clave_(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim(); }
function titulo_(t) { return String(t || '').toLowerCase().replace(/(^|\s|\()\S/g, function (m) { return m.toUpperCase(); }); }

function catalogo_() {
  var acts = leer_('Actividades').filter(function (a) { return esSi_(a.activa) && String(a.codact).indexOf('NP-') !== 0; });
  var frentes = [], capitulos = [], subcapitulos = [], actividades = [], vistos = {};
  acts.forEach(function (a) {
    var f = String(a.codfrente), c = String(a.codcap), s = String(a.codsubcap);
    if (!vistos['f' + f]) { vistos['f' + f] = 1; frentes.push({ cod: f, nombre: a.frenteNombre }); }
    if (!vistos['c' + c]) { vistos['c' + c] = 1; capitulos.push({ cod: c, codFrente: f, nombre: a.capNombre + ' (' + a.frenteNombre + ')' }); }
    if (!vistos['s' + s]) { vistos['s' + s] = 1; subcapitulos.push({ cod: s, codCapitulo: c, nombre: a.subcapNombre + ' (' + a.frenteNombre + ')' }); }
    actividades.push({ cod: String(a.codact), codSubcap: s, desc: a.actDesc + ' (' + a.frenteNombre + ')', unidad: a.unidad });
  });
  var nomFrente = {}; frentes.forEach(function (f) { nomFrente[f.cod] = f.nombre; });

  // Maestros: residente y frentes (en la columna frente pueden ir varios separados por coma)
  var maestros = leer_('Maestros').filter(function (m) { return esSi_(m.activo); });
  var residenteDeMaestro = {}, residenteFrente = [], vistosRF = {};
  maestros.forEach(function (m) {
    var res = String(m.residente || '').trim() || ('Maestro ' + m.nombre);
    residenteDeMaestro[clave_(m.nombre)] = res;
    String(m.frente || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(String).forEach(function (cf) {
      var k = clave_(res) + '|' + cf;
      if (vistosRF[k]) return; vistosRF[k] = 1;
      residenteFrente.push({ codFrente: cf, display: cf + ' - ' + (nomFrente[cf] || cf), residenteKey: clave_(res) });
    });
  });
  var cedMaestros = {}; maestros.forEach(function (m) { cedMaestros[String(m.cedula)] = 1; });

  var personal = leer_('Personal').filter(function (p) {
    return String(p.estado).toUpperCase() === 'ACTIVO' && (esSi_(p.enApp) || cedMaestros[String(p.cedula)]);
  }).map(function (p) {
    var esM = !!cedMaestros[String(p.cedula)];
    var res = esM ? residenteDeMaestro[clave_(p.nombre)] : (String(p.residente || '').trim() || residenteDeMaestro[clave_(p.maestro)] || '');
    return { cedula: String(p.cedula), nombre: String(p.nombre).trim(), cargo: titulo_(p.cargo), residente: res,
             residenteKey: clave_(res), maestro: String(p.maestro || ''), esMaestro: esM };
  });

  var parametros = {};
  leer_('Parametros').forEach(function (p) { if (p.parametro && p.parametro !== 'festivo') parametros[p.parametro] = p.valor; });
  parametros.festivos = leer_('Parametros').filter(function (p) { return p.parametro === 'festivo'; })
    .map(function (p) { return fechaTexto_(p.valor); });

  return { ok: true, obra: 'Milán Campestre', generado: new Date().toISOString(),
           frentes: frentes, capitulos: capitulos, subcapitulos: subcapitulos, actividades: actividades,
           personal: personal, residenteFrente: residenteFrente, recargos: RECARGOS, parametros: parametros };
}

/* ---------- Escritura ---------- */
function agregar_(nombreHoja, filas) {
  var hoja = SpreadsheetApp.getActive().getSheetByName(nombreHoja);
  var enc = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String);
  var colId = enc.indexOf('id');
  var ultima = ultimaFila_(hoja, colId + 1);
  var existentes = {};
  if (colId >= 0 && ultima > 1) {
    hoja.getRange(2, colId + 1, ultima - 1, 1).getValues().forEach(function (v) { existentes[String(v[0])] = true; });
  }
  var nuevas = [], repetidas = 0;
  filas.forEach(function (f) {
    if (!f.id) f.id = new Date().getTime() + '_' + Math.random().toString(36).slice(2, 8);
    if (existentes[String(f.id)]) { repetidas++; return; }
    existentes[String(f.id)] = true;
    if (!f.creado) f.creado = new Date().toISOString();
    var g = {}; Object.keys(f).forEach(function (k) { g[k.toLowerCase()] = f[k]; });
    if (g.codcat === undefined && g.codact !== undefined) g.codcat = g.codact;
    nuevas.push(enc.map(function (c) {
      var v = g[c.toLowerCase()]; if (v === undefined || v === null) v = '';
      return COLUMNAS_TEXTO.indexOf(c) >= 0 ? String(v) : v;
    }));
  });
  if (nuevas.length) {
    var rango = hoja.getRange(ultima + 1, 1, nuevas.length, enc.length);
    enc.forEach(function (c, j) {
      if (COLUMNAS_TEXTO.indexOf(c) >= 0) hoja.getRange(ultima + 1, j + 1, nuevas.length, 1).setNumberFormat('@');
    });
    rango.setValues(nuevas);
  }
  return { agregadas: nuevas.length, repetidas: repetidas };
}

/* Última fila con dato real en la columna de id (evita el error de filas fantasma de getLastRow). */
function ultimaFila_(hoja, col) {
  var n = hoja.getLastRow();
  if (n < 2) return 1;
  var vals = hoja.getRange(1, col || 1, n, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) { if (String(vals[i][0]) !== '') return i + 1; }
  return 1;
}

/* ---------- Utilidades ---------- */
function leer_(nombre) {
  var hoja = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!hoja || hoja.getLastRow() < 2) return [];
  var v = hoja.getDataRange().getValues();
  var enc = v[0].map(String);
  return v.slice(1).filter(function (r) { return String(r[0]) !== ''; }).map(function (r) {
    var o = {}; enc.forEach(function (c, j) { o[c] = r[j]; }); return o;
  });
}
function esSi_(v) { var s = String(v).trim().toUpperCase(); return s === 'SÍ' || s === 'SI' || s === 'TRUE'; }
function fechaTexto_(v) {
  return (v instanceof Date) ? Utilities.formatDate(v, 'America/Bogota', 'yyyy-MM-dd') : String(v);
}
function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* Prueba manual desde el editor: Ejecutar → probarCatalogo y ver el registro de ejecución. */
function probarCatalogo() {
  var c = catalogo_();
  Logger.log('Frentes: ' + c.frentes.length + ' · Personal: ' + c.personal.length + ' · Maestros: ' + c.personal.filter(function (p) { return p.esMaestro; }).length + ' · Actividades: ' + c.actividades.length);
}
