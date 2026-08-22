/**
 * Normalización y validación de los datos de una PERSONA: cuentas de usuario
 * (M1) y fichas de profesional (CFG-01).
 *
 * Los dos formularios pedían lo mismo —nombre, correo, teléfono, especialidad—
 * y cada uno lo validaba a su manera, o no lo validaba: se podían guardar
 * nombres de una letra, correos sin arroba y teléfonos con letras. Aquí está la
 * regla, una sola vez, y la aplican los dos módulos.
 *
 * Dos decisiones que conviene tener presentes:
 *
 * 1. **Los textos se guardan en MAYÚSCULAS** (nombre, especialidad). Lo pidió el
 *    cliente para que todo el sistema se lea igual, y de paso quita la mitad de
 *    los duplicados por escritura: "Juan Pérez" y "JUAN PEREZ" dejan de ser dos.
 *
 * 2. **El correo NO**: se guarda en minúsculas. Es la credencial con la que se
 *    recupera la contraseña y con la que se comparan duplicados; pasarlo a
 *    mayúsculas rompería esas comparaciones sin ganar nada, porque un correo no
 *    distingue mayúsculas.
 */
import { badRequest } from './httpError.js';

/**
 * Letras (con tildes y Ñ), espacios y los signos que aparecen de verdad en los
 * nombres de este sistema.
 *
 * El '&' y los paréntesis están porque las cuentas del cliente los usan:
 * "Administrador Maestro JD&D", "Marcela Rueda (Asistente)". Sin ellos el
 * propio perfil del maestro era imposible de guardar —el aviso salía sobre el
 * nombre aunque se estuviera editando el teléfono— y el filtro de tecleo
 * borraba el '&' según se escribía, así que tampoco había forma de corregirlo.
 * Los dígitos siguen fuera: una persona no se llama con números.
 */
const SOLO_LETRAS = /^[A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ\s'’.\-&()]*$/;
const CORREO = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/** Espacios colapsados, sin bordes y en mayúsculas. */
export function textoPersona(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Solo los dígitos: '+57 300 111 2233' → '573001112233'. */
export const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Nombre de persona. `campo` es cómo se llama en pantalla, para que el mensaje
 * hable el idioma del formulario y no el de la columna.
 */
export function validarNombre(v, campo = 'El nombre') {
  const nombre = textoPersona(v);
  if (!nombre) throw badRequest(`${campo} es obligatorio.`);
  if (nombre.length < 3) throw badRequest(`${campo} debe tener al menos 3 caracteres.`);
  if (nombre.length > 120) throw badRequest(`${campo} no puede pasar de 120 caracteres.`);
  if (!SOLO_LETRAS.test(nombre)) {
    throw badRequest(`${campo} solo admite letras, espacios y los signos ' . - & ( ) — sin números.`);
  }
  return nombre;
}

/** Texto libre corto y opcional (especialidad, cargo…). Vacío → null. */
export function validarTextoOpcional(v, campo, { minimo = 3, maximo = 120 } = {}) {
  const texto = textoPersona(v);
  if (!texto) return null;
  if (texto.length < minimo) throw badRequest(`${campo} debe tener al menos ${minimo} caracteres.`);
  if (texto.length > maximo) throw badRequest(`${campo} no puede pasar de ${maximo} caracteres.`);
  return texto;
}

export function validarCorreo(v, { obligatorio = true } = {}) {
  const correo = String(v ?? '').trim().toLowerCase();
  if (!correo) {
    if (obligatorio) throw badRequest('El correo es obligatorio.');
    return null;
  }
  if (!CORREO.test(correo)) {
    throw badRequest('El correo no tiene un formato válido (ejemplo: nombre@empresa.com).');
  }
  if (correo.length > 150) throw badRequest('El correo no puede pasar de 150 caracteres.');
  return correo;
}

/**
 * Teléfono colombiano. Se guarda SOLO con dígitos: es como se compara para
 * detectar duplicados, y así '+57 300 111 2233' y '3001112233' dejan de ser dos
 * números distintos en la base.
 */
export function validarTelefono(v, { obligatorio = false } = {}) {
  const digitos = soloDigitos(v);
  if (!digitos) {
    if (obligatorio) throw badRequest('El teléfono es obligatorio.');
    return null;
  }
  if (digitos.length < 7) throw badRequest('El teléfono debe tener al menos 7 dígitos.');
  if (digitos.length > 15) throw badRequest('El teléfono no puede pasar de 15 dígitos.');
  return digitos;
}

/**
 * Documento de identidad. Se admite alfanumérico (hay pasaportes y cédulas de
 * extranjería con letras) pero sin puntos ni espacios, que es lo que hacía que
 * '1.020.304' y '1020304' entraran como dos personas.
 */
export function validarDocumento(v, { obligatorio = true } = {}) {
  const doc = String(v ?? '').replace(/[\s.\-]/g, '').toUpperCase();
  if (!doc) {
    if (obligatorio) throw badRequest('El documento de identidad es obligatorio.');
    return null;
  }
  if (!/^[0-9A-Z]{5,20}$/.test(doc)) {
    throw badRequest('El documento debe tener entre 5 y 20 caracteres, sin espacios ni símbolos.');
  }
  return doc;
}

/** Valor monetario por hora: número, no negativo y con un techo razonable. */
export function validarValorHora(v, { obligatorio = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (obligatorio) throw badRequest('El valor hora es obligatorio.');
    return 0;
  }
  // Formato colombiano: el punto separa miles y la coma, decimales. Sin esto,
  // "70.000" se leía como setenta pesos la hora en vez de setenta mil.
  let texto = String(v).replace(/[^\d.,-]/g, '');
  if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(texto)) texto = texto.replace(/\./g, '');
  const n = Number(texto);
  if (!Number.isFinite(n)) throw badRequest('El valor hora debe ser un número.');
  if (n < 0) throw badRequest('El valor hora no puede ser negativo.');
  if (n > 100000000) throw badRequest('El valor hora es demasiado alto; revise la cifra.');
  return n;
}
