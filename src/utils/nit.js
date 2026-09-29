/**
 * NIT: normalización y dígito de verificación.
 *
 * ## Por qué existe
 *
 * `general.gener_negocio.nit` es un `varchar(50)` de texto libre, así que ahí dentro hay de todo:
 * `900.123.456-7`, `900123456`, `900 123 456 - 7`, y alguno con el DV pegado sin guion. Para
 * facturar hace falta el número **limpio** y el **dígito de verificación por separado**, porque
 * así los pide la DIAN y porque un DV equivocado hace que el documento se rechace entero.
 *
 * ## Lo que este archivo NO hace
 *
 * **No adivina el DV de un NIT que venga con dígitos pegados.** Si llega `9001234567` no hay forma
 * de saber si son diez dígitos de NIT o nueve más el DV: las dos lecturas son válidas y solo el
 * RUT lo resuelve. En ese caso se devuelve el número tal cual y `dv: null`, y que lo capture una
 * persona mirando el RUT. Inventar un dato fiscal es peor que no tenerlo.
 *
 * ## El algoritmo
 *
 * El de la DIAN: se multiplica cada dígito, de derecha a izquierda, por una serie fija de primos;
 * se suma; se toma el residuo entre 11. Si el residuo es 0 o 1, ese es el DV; si no, es 11 menos
 * el residuo.
 *
 * Comprobado a mano contra dos NIT públicos y conocidos, que están en los tests:
 * la DIAN (`800197268-4`) y Bancolombia (`890903938-8`).
 */

/** Los pesos del algoritmo de la DIAN, de derecha a izquierda. */
const PRIMOS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/**
 * Deja solo los dígitos de un documento.
 *
 * @param {string|number|null|undefined} valor
 * @returns {string|null} Solo dígitos, o null si no queda nada utilizable.
 */
function normalizarDocumento(valor) {
    if (valor === null || valor === undefined) return null;
    const digitos = String(valor).replace(/\D/g, '');
    return digitos.length > 0 ? digitos : null;
}

/**
 * Calcula el dígito de verificación de un NIT.
 *
 * @param {string|number} nit Número SIN el DV. Se le quitan separadores antes de calcular.
 * @returns {number|null} El DV (0–9), o null si el NIT no es utilizable.
 */
function calcularDv(nit) {
    const numero = normalizarDocumento(nit);
    if (!numero) return null;
    if (numero.length > PRIMOS.length) return null;

    let suma = 0;
    for (let i = 0; i < numero.length; i++) {
        // Se recorre de derecha a izquierda: el último dígito lleva el primer primo.
        const digito = Number(numero[numero.length - 1 - i]);
        suma += digito * PRIMOS[i];
    }

    const residuo = suma % 11;
    return residuo > 1 ? 11 - residuo : residuo;
}

/**
 * ¿El DV que nos dieron es el que corresponde a ese NIT?
 *
 * @param {string|number} nit Número sin el DV.
 * @param {string|number} dv El dígito a comprobar.
 * @returns {boolean}
 */
function esDvValido(nit, dv) {
    const esperado = calcularDv(nit);
    if (esperado === null) return false;
    const recibido = normalizarDocumento(dv);
    if (recibido === null || recibido.length !== 1) return false;
    return Number(recibido) === esperado;
}

/**
 * Parte un NIT escrito de cualquier forma en `{ numero, dv }`.
 *
 * Solo separa el DV cuando el texto lo trae **explícitamente marcado** con un guion o un espacio
 * al final (`900123456-7`). Si viene todo pegado devuelve `dv: null` a propósito: ver la nota de
 * arriba sobre no adivinar.
 *
 * @param {string|number|null|undefined} valor
 * @returns {{numero: string|null, dv: string|null, dvCalculado: number|null, coherente: boolean|null}}
 *   `coherente` es null cuando no había DV que comparar.
 */
function separarNit(valor) {
    const vacio = { numero: null, dv: null, dvCalculado: null, coherente: null };
    if (valor === null || valor === undefined) return vacio;

    const texto = String(valor).trim();
    if (!texto) return vacio;

    // ¿Trae el DV marcado al final? Un guion o un espacio y un solo dígito.
    const marcado = texto.match(/^(.*\d)\s*[-\s]\s*(\d)$/);

    const numero = normalizarDocumento(marcado ? marcado[1] : texto);
    if (!numero) return vacio;

    const dv = marcado ? marcado[2] : null;
    const dvCalculado = calcularDv(numero);

    return {
        numero,
        dv,
        dvCalculado,
        coherente: dv === null ? null : Number(dv) === dvCalculado,
    };
}

export { normalizarDocumento, calcularDv, esDvValido, separarNit };
