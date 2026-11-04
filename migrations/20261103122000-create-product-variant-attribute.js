/* eslint-disable no-undef */
'use strict';

/**
 * De 0 a n atributos por presentación, para casos como "20 ml · Amarillo", que
 * son medida y atributo a la vez. Un tipo no puede repetirse en la misma
 * presentación: no hay nada que sea de dos colores ni de dos tallas.
 *
 * CASCADE desde `product_variant` porque los atributos no son historial: son
 * parte de la presentación, y el borrado físico del punto 3 ya solo ocurre
 * cuando no hay ningún documento detrás. RESTRICT hacia `attribute_type`, que
 * es una lista fija de la que nada se borra.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.createTable('product_variant_attribute', {
			id: {
				type: Sequelize.UUID,
				allowNull: false,
				defaultValue: Sequelize.literal('uuid_generate_v4()'),
				primaryKey: true,
			},
			productVariantId: {
				type: Sequelize.UUID,
				allowNull: false,
				references: { model: 'product_variant', key: 'id' },
				onUpdate: 'CASCADE',
				onDelete: 'CASCADE',
			},
			attributeTypeId: {
				type: Sequelize.UUID,
				allowNull: false,
				references: { model: 'attribute_type', key: 'id' },
				onUpdate: 'CASCADE',
				onDelete: 'RESTRICT',
			},
			value: {
				type: Sequelize.STRING(120),
				allowNull: false,
			},
			createdDate: {
				type: Sequelize.DATE,
				allowNull: false,
				defaultValue: Sequelize.literal('now()'),
			},
			updatedDate: {
				type: Sequelize.DATE,
				allowNull: false,
				defaultValue: Sequelize.literal('now()'),
			},
		});

		await queryInterface.addIndex(
			'product_variant_attribute',
			['productVariantId'],
			{ name: 'idx_product_variant_attribute_variant' },
		);

		await queryInterface.addConstraint('product_variant_attribute', {
			type: 'unique',
			fields: ['productVariantId', 'attributeTypeId'],
			name: 'uq_product_variant_attribute_variant_type',
		});
	},

	async down(queryInterface) {
		await queryInterface.dropTable('product_variant_attribute');
	},
};
