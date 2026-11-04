/* eslint-disable no-undef */
'use strict';

/**
 * Los ejes de una presentación, todos opcionales e independientes: cantidad con
 * su unidad, envase, y los atributos en su propia tabla hija. No hay columna
 * discriminadora que elija entre ellos, porque hay casos que llevan varios a la
 * vez (Easy Color es medida y color; `Galon (3.5 Kilos)` es envase y masa).
 *
 * Todas las columnas entran NULL, así que las 948 presentaciones actuales
 * quedan exactamente como están: el nombre de texto libre sigue siendo el que
 * manda hasta que el backfill del punto 5 las estructure. `isCapacity` entra
 * NOT NULL con default constante, que Postgres aplica sin reescribir la tabla.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn('product_variant', 'quantityValue', {
			type: Sequelize.DECIMAL(12, 3),
			allowNull: true,
		});

		await queryInterface.addColumn('product_variant', 'unitId', {
			type: Sequelize.UUID,
			allowNull: true,
			references: { model: 'measurement_unit', key: 'id' },
			onUpdate: 'CASCADE',
			// RESTRICT: una unidad en uso no se puede borrar, se desactiva
			onDelete: 'RESTRICT',
		});

		await queryInterface.addColumn('product_variant', 'containerId', {
			type: Sequelize.UUID,
			allowNull: true,
			references: { model: 'container', key: 'id' },
			onUpdate: 'CASCADE',
			onDelete: 'RESTRICT',
		});

		/**
		 * Marca que el número es capacidad del envase y no cantidad de producto
		 * (Jarra de Aluminio 250 ml / 500 ml / 1 lt). Se muestra y se ordena igual,
		 * pero queda fuera de la resolución por peso y volumen de Gema, que
		 * responde cuánto producto lleva la presentación
		 */
		await queryInterface.addColumn('product_variant', 'isCapacity', {
			type: Sequelize.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		});

		/**
		 * Derivada: `quantityValue` por el `factorToBase` de su unidad. Es lo que
		 * permite ordenar "1 lt" después de "250 ml" en vez de alfabéticamente, que
		 * es lo que hace hoy la tabla ("1 kilo" antes que "100 grs")
		 */
		await queryInterface.addColumn('product_variant', 'quantityBase', {
			type: Sequelize.DECIMAL(18, 6),
			allowNull: true,
		});

		/**
		 * Derivada: la firma canónica de la presentación, que es lo que hace única
		 * la combinación de ejes. No sirve un UNIQUE sobre (productId,
		 * quantityValue, unitId): medido en producción, 8 grupos de presentaciones
		 * legítimas comparten medida y se distinguen solo por el atributo, y los
		 * atributos viven en la tabla hija, de donde no los alcanza un índice
		 */
		await queryInterface.addColumn('product_variant', 'variantKey', {
			// TEXT y no STRING(n): la firma lleva los valores de los atributos, y un
			// límite obligaría a recortarlos, que es romper la unicidad en silencio
			type: Sequelize.TEXT,
			allowNull: true,
		});

		await queryInterface.addIndex('product_variant', ['quantityBase'], {
			name: 'idx_product_variant_quantity_base',
		});

		/**
		 * El índice es parcial sobre `deletedDate IS NULL` por una razón concreta:
		 * las presentaciones inactivas SÍ tienen que entrar en la unicidad, porque
		 * el cliente desactiva en vez de borrar y crear una "500 g" nueva sin ver la
		 * "500 gramos" inactiva del mismo producto deja dos duplicadas en cuanto
		 * reactive la vieja. Las borradas lógicamente, en cambio, tienen que quedar
		 * fuera: desde el punto 3 una presentación con facturas detrás se borra
		 * marcándola, y un índice total impediría volver a crear esa misma
		 * presentación después.
		 *
		 * Las filas con `variantKey` NULL no colisionan entre sí, así que el índice
		 * se crea sobre las 948 actuales sin tocar ninguna y solo empieza a exigir
		 * algo a medida que se estructuran.
		 */
		await queryInterface.sequelize.query(`
			CREATE UNIQUE INDEX "uq_product_variant_product_variant_key"
			ON "product_variant" ("productId", "variantKey")
			WHERE "deletedDate" IS NULL
		`);
	},

	async down(queryInterface) {
		await queryInterface.sequelize.query(
			'DROP INDEX IF EXISTS "uq_product_variant_product_variant_key"',
		);
		await queryInterface.removeIndex(
			'product_variant',
			'idx_product_variant_quantity_base',
		);
		await queryInterface.removeColumn('product_variant', 'variantKey');
		await queryInterface.removeColumn('product_variant', 'quantityBase');
		await queryInterface.removeColumn('product_variant', 'isCapacity');
		await queryInterface.removeColumn('product_variant', 'containerId');
		await queryInterface.removeColumn('product_variant', 'unitId');
		await queryInterface.removeColumn('product_variant', 'quantityValue');
	},
};
