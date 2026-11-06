/* eslint-disable no-undef */
'use strict';

/**
 * Quita dos columnas muertas de `product_variant`:
 *
 * - `quantity`: las existencias viven en `stock_item`, esta se quedó en 0.
 * - `productVariantId`: apunta a `transaction_item` y nunca se llenó.
 *
 * Se comprueba antes de borrar, con las filas borradas incluidas, y si alguna
 * tiene un valor la migración se detiene sin tocar nada. `down` devuelve las
 * columnas con su forma original, pero no datos: por eso la comprobación.
 *
 * El código que deja de leerlas debe estar desplegado antes de correr esto: el
 * modelo anterior las pide en cada SELECT y fallaría.
 */
module.exports = {
	async up(queryInterface) {
		await queryInterface.sequelize.transaction(async transaction => {
			const [[{ total }]] = await queryInterface.sequelize.query(
				`SELECT COUNT(*)::int AS total
				FROM product_variant
				WHERE quantity <> 0 OR "productVariantId" IS NOT NULL`,
				{ transaction },
			);

			if (total > 0) {
				throw new Error(
					`${total} presentaciones tienen datos en las columnas a eliminar`,
				);
			}

			await queryInterface.removeColumn('product_variant', 'quantity', {
				transaction,
			});
			await queryInterface.removeColumn('product_variant', 'productVariantId', {
				transaction,
			});
		});
	},

	async down(queryInterface, Sequelize) {
		await queryInterface.sequelize.transaction(async transaction => {
			await queryInterface.addColumn(
				'product_variant',
				'quantity',
				{
					type: Sequelize.INTEGER,
					allowNull: false,
					defaultValue: 0,
				},
				{ transaction },
			);
			await queryInterface.addColumn(
				'product_variant',
				'productVariantId',
				{
					type: Sequelize.UUID,
					allowNull: true,
					references: { model: 'transaction_item', key: 'id' },
					onUpdate: 'CASCADE',
					onDelete: 'SET NULL',
				},
				{ transaction },
			);
		});
	},
};
