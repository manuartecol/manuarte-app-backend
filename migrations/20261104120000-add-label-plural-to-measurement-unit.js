/* eslint-disable no-undef */
'use strict';

/**
 * Plural de la etiqueta, para las unidades que son palabras.
 *
 * Sin esto el nombre compuesto sale "3 docena" y "2 galón": la composición pega
 * la cantidad y la etiqueta tal cual, y con las abreviaturas (g, kg, ml, lt,
 * mm, m) eso es correcto, pero con las palabras no. Se ve en cuanto el
 * formulario muestra la vista previa.
 *
 * Va en la tabla y no en el código, igual que `factorToBase`: las tres formas
 * del español son irregulares (docena/docenas, galón/galones,
 * unidad/unidades) y una regla acertaría en una de las tres.
 *
 * `labelPlural` es NULL para las abreviaturas, y la composición cae a `label`
 * cuando no hay plural. No cambia ninguna firma: `variantKey` lleva la
 * dimensión y el valor en base, nunca la etiqueta.
 */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn('measurement_unit', 'labelPlural', {
			type: Sequelize.STRING(32),
			allowNull: true,
		});

		/**
		 * El seeder ya trae el plural para una base nueva, pero local y staging
		 * están sembradas desde antes: estas filas se corrigen aquí. Por `code`,
		 * que es UNIQUE, y sin tocar las que no son palabras
		 */
		const plurals = [
			['unidad', 'unidades'],
			['docena', 'docenas'],
			['gal', 'galones'],
		];

		for (const [code, labelPlural] of plurals) {
			await queryInterface.sequelize.query(
				`UPDATE measurement_unit SET "labelPlural" = :labelPlural, "updatedDate" = now() WHERE code = :code`,
				{ replacements: { code, labelPlural } },
			);
		}
	},

	async down(queryInterface) {
		await queryInterface.removeColumn('measurement_unit', 'labelPlural');
	},
};
