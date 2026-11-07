/* eslint-disable no-undef */
'use strict';

/**
 * Las Pilas AAA se venden por par. Unidad de conteo con factor 2, igual que la
 * docena con factor 12, y plural propio para "3 pares".
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		const now = new Date();

		await queryInterface.bulkInsert('measurement_unit', [
			{
				id: Sequelize.literal('uuid_generate_v4()'),
				code: 'par',
				label: 'par',
				labelPlural: 'pares',
				name: 'Par',
				dimension: 'count',
				factorToBase: 2,
				sortOrder: 15,
				active: true,
				createdDate: now,
				updatedDate: now,
			},
		]);
	},

	async down(queryInterface) {
		await queryInterface.bulkDelete('measurement_unit', { code: 'par' });
	},
};
