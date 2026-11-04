/* eslint-disable no-undef */
'use strict';

/**
 * Las tres listas fijas. Salen de barrer las 948 presentaciones de producción:
 * las únicas unidades escritas son `gramos` (135), `ml` (119), `grs` (55),
 * `kilos` (33), `kilo` (19), `mm` (8), `galon` (6), `litro` (2), `docena` (1) y
 * `metros` (1), más las 278 que son `unidad` en alguna de sus grafías. No hay
 * ni una sola con `oz`, `lb`, `cm` ni pulgadas, así que la lista es corta.
 *
 * `docena` y `metro` no estaban en la lista planeada y entran igual: son una
 * presentación cada una, y sin ellas el backfill del punto 5 dejaría dos filas
 * sin mapear a cambio de no insertar dos filas de catálogo.
 *
 * `cc` no entra como unidad: 1 cc = 1 cm³ = 1 ml, y aparece en 14 nombres de
 * producto pero en cero presentaciones, así que es un alias que solo hace falta
 * al separar los nombres, no una unidad que el formulario deba ofrecer.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		const now = new Date();

		const units = [
			// code, label, name, dimension, factorToBase, sortOrder
			['unidad', 'unidad', 'Unidad', 'count', 1, 10],
			['docena', 'docena', 'Docena', 'count', 12, 20],
			['g', 'g', 'Gramo', 'mass', 1, 30],
			['kg', 'kg', 'Kilogramo', 'mass', 1000, 40],
			['ml', 'ml', 'Mililitro', 'volume', 1, 50],
			['lt', 'lt', 'Litro', 'volume', 1000, 60],
			// Galón estadounidense, que es el que se usa en Colombia y Ecuador
			['gal', 'galón', 'Galón', 'volume', 3785.411784, 70],
			['mm', 'mm', 'Milímetro', 'length', 1, 80],
			['m', 'm', 'Metro', 'length', 1000, 90],
		];

		await queryInterface.bulkInsert(
			'measurement_unit',
			units.map(([code, label, name, dimension, factorToBase, sortOrder]) => ({
				id: Sequelize.literal('uuid_generate_v4()'),
				code,
				label,
				name,
				dimension,
				factorToBase,
				sortOrder,
				active: true,
				createdDate: now,
				updatedDate: now,
			})),
		);

		const containers = [
			['bolsa', 'Bolsa', 10],
			['caja', 'Caja', 20],
			['bloque', 'Bloque', 30],
			['bulto', 'Bulto', 40],
			['frasco', 'Frasco', 50],
		];

		await queryInterface.bulkInsert(
			'container',
			containers.map(([code, label, sortOrder]) => ({
				id: Sequelize.literal('uuid_generate_v4()'),
				code,
				label,
				sortOrder,
				active: true,
				createdDate: now,
				updatedDate: now,
			})),
		);

		/**
		 * Lista corta y cerrada. Sin `forma`: las figuras de molde pasan a ser
		 * productos, que es como el cliente ya lo hace en 186 de sus 228 productos
		 * de molde. `densidad` queda fuera hasta que el cliente diga si el Gel Para
		 * Velas de alta densidad es el mismo producto o otro
		 */
		const attributeTypes = [
			['color', 'Color', '{value}', 10],
			['talla', 'Talla', '{value}', 20],
			['cavidades', 'Cavidades', '{value} cavidades', 30],
		];

		await queryInterface.bulkInsert(
			'attribute_type',
			attributeTypes.map(([code, label, valueTemplate, sortOrder]) => ({
				id: Sequelize.literal('uuid_generate_v4()'),
				code,
				label,
				valueTemplate,
				sortOrder,
				active: true,
				createdDate: now,
				updatedDate: now,
			})),
		);
	},

	async down(queryInterface) {
		await queryInterface.bulkDelete('attribute_type', null, {});
		await queryInterface.bulkDelete('container', null, {});
		await queryInterface.bulkDelete('measurement_unit', null, {});
	},
};
