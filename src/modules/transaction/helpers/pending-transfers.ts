import { QueryTypes, Transaction } from 'sequelize';
import { format, isValid } from 'date-fns';
import { sequelize } from '../../../config/database';
import { PendingTransfer, TransactionState, TransactionType } from '../types';

/**
 * Las transferencias de una presentación que todavía no se aceptaron.
 *
 * Una transferencia en `PROGRESS` ya restó del origen y todavía no sumó al
 * destino: sus unidades no están en ninguna bodega. Cualquier comprobación que
 * mire solo `stock_item.quantity` las pasa por alto, y por eso tanto el borrado
 * de la presentación como la desactivación de una bodega preguntan por aquí.
 *
 * Una sola función para las dos, para que no puedan discrepar: si una bloquea y
 * la otra no, el usuario encuentra el camino que deja las unidades en el aire.
 */
export const getPendingTransfersByProductVariant = async (
	productVariantId: string,
	transaction?: Transaction,
): Promise<PendingTransfer[]> => {
	const pendingTransfers = await sequelize.query<PendingTransfer>(
		`
			SELECT
				t.id,
				t.name,
				t."createdDate",
				t."fromId",
				sf.name AS "fromName",
				t."toId",
				st.name AS "toName",
				ti.quantity
			FROM transaction_item ti
			INNER JOIN "transaction" t ON t.id = ti."transactionId"
			LEFT JOIN stock sf ON sf.id = t."fromId"
			LEFT JOIN stock st ON st.id = t."toId"
			WHERE ti."productVariantId" = :productVariantId
				AND ti."deletedDate" IS NULL
				AND t."deletedDate" IS NULL
				AND t.type = :transfer
				AND t.state = :progress
			ORDER BY t."createdDate" ASC
		`,
		{
			replacements: {
				productVariantId,
				transfer: TransactionType.TRANSFER,
				progress: TransactionState.PROGRESS,
			},
			type: QueryTypes.SELECT,
			transaction,
		},
	);

	return pendingTransfers.map(pendingTransfer => ({
		...pendingTransfer,
		quantity: Number(pendingTransfer.quantity),
	}));
};

/**
 * Las bodegas de destino de las transferencias pendientes, que son las que no
 * se pueden desactivar: al aceptarlas las unidades aterrizan ahí, y en un item
 * desactivado no las muestra ningún listado.
 *
 * El origen no se bloquea. Devolverle unidades exige editar la transferencia
 * pendiente, y eso no existe en el panel: la tabla de movimientos no tiene
 * acción de editar y el drawer de transferencia siempre se abre vacío, así que
 * `PUT /transfer/:id` solo se alcanza llamando a la API. Ese camino lo corta
 * `TransactionItemService.update` en el momento de escribir, que es más fiable
 * que bloquear la desactivación por adelantado
 */
export const getLockedDestinationStockIds = (
	pendingTransfers: PendingTransfer[],
): Map<string, PendingTransfer[]> => {
	const locked = new Map<string, PendingTransfer[]>();

	for (const pendingTransfer of pendingTransfers) {
		const stockId = pendingTransfer.toId;

		if (!stockId) continue;

		// Todas las de esa bodega, no solo la primera: una bodega puede ser el
		// destino de varias transferencias pendientes, y el aviso que nombra una
		// sola deja al usuario resolviendo a ciegas
		const forStock = locked.get(stockId) ?? [];
		forStock.push(pendingTransfer);
		locked.set(stockId, forStock);
	}

	return locked;
};

/**
 * El texto con el que se le explica al usuario qué transferencia lo está
 * frenando. Sale de aquí para que el borrado y la desactivación digan lo mismo.
 *
 * Lleva la fecha porque sin ella el usuario no sabe qué fila buscar en
 * Movimientos de Stock: el nombre de la transferencia es `TRANSFER_<fecha>_
 * <timestamp>`, que no se puede leer, y el listado se ordena por fecha
 */
export const describePendingTransfers = (
	pendingTransfers: PendingTransfer[],
): string =>
	pendingTransfers
		.map(pendingTransfer => {
			const units =
				pendingTransfer.quantity === 1
					? '1 unidad'
					: `${pendingTransfer.quantity} unidades`;

			return `${units} de ${pendingTransfer.fromName ?? 'origen desconocido'} a ${pendingTransfer.toName ?? 'destino desconocido'}, del ${formatTransferDate(pendingTransfer.createdDate)}`;
		})
		.join('; ');

/**
 * `createDate` llega como `Date` desde `pg` y como string si alguien serializó
 * la fila por el camino, así que se admiten los dos
 */
const formatTransferDate = (createdDate: string | Date): string => {
	const date = createdDate instanceof Date ? createdDate : new Date(createdDate);

	return isValid(date) ? format(date, 'dd/MM/yyyy') : 'fecha desconocida';
};
