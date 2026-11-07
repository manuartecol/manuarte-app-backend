/* eslint-disable no-undef */
'use strict';

/**
 * Lo que el backfill del punto 5 necesita y la semilla no trae:
 *
 * - `cc`: Easy Color se vende en cc y los aceites en ml. Vale lo mismo que ml,
 *   así que comparten firma y 20 cc y 20 ml del mismo producto son un duplicado.
 * - `densidad`: Gel Para Velas tiene alta densidad y normal.
 * - Envases: `pote` lo pidió el cliente; los demás salen de las presentaciones.
 *
 * `down` falla si alguna presentación ya los usa: las claves foráneas son
 * RESTRICT, y es lo correcto.
 */
const CONTAINERS = [
	['paquete', 'Paquete', 60],
	['pimpina', 'Pimpina', 70],
	['galon', 'Galón', 80],
	['rollo', 'Rollo', 90],
	['pote', 'Pote', 100],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		const now = new Date();
		const base = {
			id: Sequelize.literal('uuid_generate_v4()'),
			active: true,
			createdDate: now,
			updatedDate: now,
		};

		await queryInterface.sequelize.transaction(async transaction => {
			await queryInterface.bulkInsert(
				'measurement_unit',
				[
					{
						...base,
						code: 'cc',
						label: 'cc',
						labelPlural: null,
						name: 'Centímetro cúbico',
						dimension: 'volume',
						factorToBase: 1,
						sortOrder: 55,
					},
				],
				{ transaction },
			);
			await queryInterface.bulkInsert(
				'container',
				CONTAINERS.map(([code, label, sortOrder]) => ({
					...base,
					code,
					label,
					sortOrder,
				})),
				{ transaction },
			);
			await queryInterface.bulkInsert(
				'attribute_type',
				[
					{
						...base,
						code: 'densidad',
						label: 'Densidad',
						valueTemplate: 'Densidad {value}',
						sortOrder: 40,
					},
				],
				{ transaction },
			);
		});
	},

	async down(queryInterface) {
		await queryInterface.sequelize.transaction(async transaction => {
			await queryInterface.bulkDelete(
				'attribute_type',
				{ code: 'densidad' },
				{ transaction },
			);
			await queryInterface.bulkDelete(
				'container',
				{ code: CONTAINERS.map(([code]) => code) },
				{ transaction },
			);
			await queryInterface.bulkDelete(
				'measurement_unit',
				{ code: 'cc' },
				{ transaction },
			);
		});
	},
};
