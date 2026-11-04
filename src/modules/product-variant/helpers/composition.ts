import { VariantAxes, VariantAttributeInput } from '../types';

/**
 * Composición de una presentación a partir de sus ejes. Son funciones puras y
 * están aquí, fuera del servicio, por dos razones: el backfill del punto 5 tiene
 * que producir exactamente las mismas firmas que produce el panel al guardar, y
 * el formulario necesita la misma vista previa del nombre que acabará guardado.
 *
 * Un cálculo distinto en cada sitio sería un duplicado silencioso: dos filas con
 * la misma presentación y firmas distintas, que es justo lo que el UNIQUE está
 * puesto para impedir.
 */

/**
 * `50.000` se guarda como `50`, `3.500` como `3.5`. Sin esto el nombre saldría
 * con los decimales del DECIMAL(12,3) de la columna
 */
const trimZeros = (fixed: string): string => {
	const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');

	return trimmed === '-0' ? '0' : trimmed;
};

const formatQuantity = (value: number): string => trimZeros(value.toFixed(3));

/**
 * Seis decimales, los mismos que el DECIMAL(18,6) de la columna. Con los tres de
 * `formatQuantity`, un galón (3785.411784 ml) se redondearía dentro de la firma
 */
const formatBase = (value: number): string => trimZeros(value.toFixed(6));

const capitalize = (value: string): string =>
	value.charAt(0).toUpperCase() + value.slice(1);

const sortAttributes = (attributes: VariantAttributeInput[]) =>
	[...attributes].sort(
		(a, b) =>
			a.type.sortOrder - b.type.sortOrder ||
			a.type.code.localeCompare(b.type.code),
	);

/**
 * El segmento de medida. Una unidad de conteo con cantidad 1 o sin cantidad se
 * imprime sola ("Unidad", "Docena"): "1 unidad" no dice nada que "Unidad" no
 * diga, y es como el cliente ya lo escribe en sus 278 presentaciones de unidad
 */
const composeMeasure = (axes: VariantAxes): string | null => {
	const { unit, quantityValue } = axes;
	if (!unit) return null;

	const hasPlainQuantity =
		quantityValue !== null &&
		quantityValue !== undefined &&
		quantityValue !== 1;

	if (unit.dimension === 'count' && !hasPlainQuantity) {
		return capitalize(unit.label);
	}

	if (quantityValue === null || quantityValue === undefined) {
		return capitalize(unit.label);
	}

	return `${formatQuantity(quantityValue)} ${unit.label}`;
};

export const composeVariantName = (axes: VariantAxes): string => {
	const measure = composeMeasure(axes);
	const container = axes.container;

	// "Bolsa x 50 g". Sin medida, el envase va solo: "Bolsa"
	const head = container
		? measure
			? `${container.label} x ${measure}`
			: container.label
		: measure;

	const attributes = sortAttributes(axes.attributes ?? []).map(attribute =>
		attribute.type.valueTemplate.replace('{value}', attribute.value.trim()),
	);

	const parts = [head, ...attributes].filter((part): part is string =>
		Boolean(part?.trim()),
	);

	// Sin ningún eje la presentación es el producto a secas, que es "Unidad"
	return parts.length > 0 ? parts.join(' · ') : 'Unidad';
};

/**
 * El valor llevado a la base de su dimensión: g para masa, ml para volumen,
 * unidad para conteo, mm para longitud. Es lo que ordena "250 ml" antes de
 * "1 lt", donde el alfabético pone "1 kilo" antes de "100 grs"
 */
export const computeQuantityBase = (axes: VariantAxes): number | null => {
	const { unit, quantityValue } = axes;
	if (!unit || quantityValue === null || quantityValue === undefined)
		return null;

	return quantityValue * Number(unit.factorToBase);
};

/**
 * La firma canónica. Lleva la dimensión y el valor en base, no la unidad: así
 * "0.5 kg" y "500 g" dan la misma firma y el UNIQUE los detecta como la
 * duplicación que son, que es exactamente el caso de Fragancia Vainilla, con
 * `500 Grs - Medio Kilo`, `500 gramos` y `- MEDIO KILO (500 GRS)` a la vez. La
 * dimensión está delante para que 500 g y 500 ml no se confundan.
 *
 * Usa los `code` de las listas fijas y no sus UUID, para que la firma se pueda
 * leer en el reporte del backfill y no cambie si las semillas se reinsertan.
 *
 * Devuelve `null` cuando no hay ningún eje: son las presentaciones todavía sin
 * estructurar, y con la firma en NULL el UNIQUE parcial no les exige nada.
 */
export const computeVariantKey = (axes: VariantAxes): string | null => {
	const hasAxes =
		Boolean(axes.unit) ||
		Boolean(axes.container) ||
		(axes.attributes ?? []).length > 0;

	if (!hasAxes) return null;

	const base = computeQuantityBase(axes);

	const measure = axes.unit
		? `${axes.unit.dimension}:${base === null ? '' : formatBase(base)}`
		: '-';

	/**
	 * La firma ordena por `code` y no por `sortOrder`, al contrario que el nombre:
	 * el orden visual es configurable, y si la firma dependiera de él, cambiar un
	 * `sortOrder` en un seeder dejaría obsoletas todas las firmas ya guardadas
	 */
	const attributes = [...(axes.attributes ?? [])]
		.sort((a, b) => a.type.code.localeCompare(b.type.code))
		.map(
			attribute =>
				`${attribute.type.code}=${attribute.value.trim().toLowerCase()}`,
		)
		.join(',');

	return [
		`m:${measure}`,
		`cap:${axes.isCapacity ? 1 : 0}`,
		`cont:${axes.container?.code ?? '-'}`,
		`at:${attributes}`,
	].join('|');
};
