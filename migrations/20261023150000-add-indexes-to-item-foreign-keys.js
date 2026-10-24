/* eslint-disable no-undef */
'use strict';

/**
 * Las tres tablas de ítems se consultan siempre por su padre
 * (`WHERE "transactionId" = ...`) y ninguna tenía índice en esa columna: solo
 * la clave primaria sobre `id`. Cada apertura de un detalle hacía un recorrido
 * secuencial completo de la tabla.
 *
 * Medido en una copia de producción: transaction_item 36.756 filas,
 * billing_item 50.129 y quote_item 16.371.
 *
 * `CREATE INDEX` toma un lock exclusivo mientras construye el índice, pero a
 * este tamaño es cuestión de milisegundos.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface) {
		await queryInterface.addIndex('transaction_item', ['transactionId'], {
			name: 'idx_transaction_item_transaction_id',
		});

		await queryInterface.addIndex('billing_item', ['billingId'], {
			name: 'idx_billing_item_billing_id',
		});

		await queryInterface.addIndex('quote_item', ['quoteId'], {
			name: 'idx_quote_item_quote_id',
		});
	},

	async down(queryInterface) {
		await queryInterface.removeIndex(
			'quote_item',
			'idx_quote_item_quote_id',
		);
		await queryInterface.removeIndex(
			'billing_item',
			'idx_billing_item_billing_id',
		);
		await queryInterface.removeIndex(
			'transaction_item',
			'idx_transaction_item_transaction_id',
		);
	},
};
