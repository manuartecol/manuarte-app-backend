import { PendingTransfer } from '../../transaction/types';
import { describePendingTransfers } from '../../transaction/helpers/pending-transfers';

/**
 * El motivo por el que una presentación no se puede eliminar, ya redactado.
 *
 * Va compuesto en el backend y viaja dentro del plan porque el mismo texto lo
 * usan dos sitios: el aviso del modal antes de confirmar y el error que se
 * lanza si alguien confirma de todas formas. Redactarlo dos veces, una en cada
 * lado, es pedir que terminen diciendo cosas distintas para el mismo caso.
 *
 * Se nombran los dos motivos cuando se dan juntos. Con uno solo a la vista, el
 * usuario resuelve ese, vuelve a intentarlo y se encuentra el otro.
 */
export const describeDeletionBlock = ({
	pendingTransfers,
	stocksWithUnits,
}: {
	pendingTransfers: PendingTransfer[];
	stocksWithUnits: { name: string; quantity: number }[];
}): string | null => {
	const hasTransfers = pendingTransfers.length > 0;
	const hasUnits = stocksWithUnits.length > 0;

	if (!hasTransfers && !hasUnits) return null;

	const transfersDetail = describePendingTransfers(pendingTransfers);
	const unitsDetail = stocksWithUnits
		.map(stock => `${stock.name} (${stock.quantity})`)
		.join(', ');

	const several = pendingTransfers.length > 1;
	const transfersSentence = several
		? `Tiene transferencias sin aceptar: ${transfersDetail}`
		: `Tiene una transferencia sin aceptar: ${transfersDetail}`;
	const unitsSentence = `Tiene unidades en stock: ${unitsDetail}`;

	/**
	 * La transferencia va primero en la instrucción: el egreso que resuelve las
	 * unidades no desbloquea nada mientras siga pendiente
	 */
	if (hasTransfers && hasUnits) {
		return `No se puede eliminar la presentación. ${transfersSentence}. Y tiene unidades en stock: ${unitsDetail}. ${
			several
				? 'Acepta las transferencias en sus bodegas de destino'
				: 'Acepta la transferencia en su bodega de destino'
		}, saca las unidades con un movimiento de salida y vuelve a intentarlo`;
	}

	if (hasTransfers) {
		return `No se puede eliminar la presentación. ${transfersSentence}. ${
			several
				? 'Acéptalas en sus bodegas de destino'
				: 'Acéptala en la bodega de destino'
		} y vuelve a intentarlo`;
	}

	/**
	 * No se ofrece desactivarla: `setActiveStocks` rechaza desactivar un item con
	 * unidades, así que el único camino real es sacarlas
	 */
	return `No se puede eliminar la presentación. ${unitsSentence}. Sácalas con un movimiento de salida y vuelve a intentarlo`;
};
