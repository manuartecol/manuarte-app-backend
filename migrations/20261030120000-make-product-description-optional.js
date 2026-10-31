/* eslint-disable no-undef */
'use strict';

/**
 * La descripción del producto deja de ser obligatoria. Al serlo, se rellenaba
 * con basura (teclado aporreado, el nombre repetido, la categoría) que acababa
 * en las respuestas de Gema y en los filtros de la tabla.
 *
 * `DROP NOT NULL` no reescribe la tabla ni toca filas: solo cambia el catálogo.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface) {
		await queryInterface.sequelize.query(
			'ALTER TABLE "product" ALTER COLUMN "description" DROP NOT NULL',
		);
	},

	async down(queryInterface) {
		// Volver a exigirla obliga a rellenar las vacías: si no, el SET NOT NULL falla
		await queryInterface.sequelize.query(
			`UPDATE "product" SET "description" = '' WHERE "description" IS NULL`,
		);
		await queryInterface.sequelize.query(
			'ALTER TABLE "product" ALTER COLUMN "description" SET NOT NULL',
		);
	},
};
