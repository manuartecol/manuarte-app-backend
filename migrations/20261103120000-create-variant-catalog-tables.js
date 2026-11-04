/* eslint-disable no-undef */
'use strict';

/**
 * Las tres listas que estructuran una presentación: unidad de medida, envase y
 * tipo de atributo. Son fijas y se mantienen por seeder, porque el cliente no
 * quiere un panel para administrarlas, así que llevan `active` en vez de
 * `deletedDate`: una unidad que deja de usarse se apaga, no se borra, y las
 * presentaciones que ya la referencian siguen resolviendo su nombre.
 *
 * `factorToBase` es lo que convierte el valor a la base de su dimensión (g para
 * masa, ml para volumen, unidad para conteo, mm para longitud). Guardar el
 * factor en la tabla, y no en el código, es lo que permite comparar y ordenar
 * "1 lt" contra "250 ml" con una sola columna derivada.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.createTable('measurement_unit', {
			id: {
				type: Sequelize.UUID,
				allowNull: false,
				defaultValue: Sequelize.literal('uuid_generate_v4()'),
				primaryKey: true,
			},
			// Identificador estable: el seeder y el backfill lo buscan por aquí
			code: {
				type: Sequelize.STRING(12),
				allowNull: false,
				unique: true,
			},
			// Lo que se imprime en el nombre compuesto de la presentación
			label: {
				type: Sequelize.STRING(24),
				allowNull: false,
			},
			// Lo que se lee en el select del formulario
			name: {
				type: Sequelize.STRING(48),
				allowNull: false,
			},
			dimension: {
				type: Sequelize.ENUM('mass', 'volume', 'count', 'length'),
				allowNull: false,
			},
			factorToBase: {
				type: Sequelize.DECIMAL(16, 6),
				allowNull: false,
			},
			sortOrder: {
				type: Sequelize.INTEGER,
				allowNull: false,
				defaultValue: 0,
			},
			active: {
				type: Sequelize.BOOLEAN,
				allowNull: false,
				defaultValue: true,
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

		await queryInterface.createTable('container', {
			id: {
				type: Sequelize.UUID,
				allowNull: false,
				defaultValue: Sequelize.literal('uuid_generate_v4()'),
				primaryKey: true,
			},
			code: {
				type: Sequelize.STRING(24),
				allowNull: false,
				unique: true,
			},
			// Con mayúscula inicial, porque abre el nombre compuesto: "Bolsa x 50 g"
			label: {
				type: Sequelize.STRING(48),
				allowNull: false,
			},
			sortOrder: {
				type: Sequelize.INTEGER,
				allowNull: false,
				defaultValue: 0,
			},
			active: {
				type: Sequelize.BOOLEAN,
				allowNull: false,
				defaultValue: true,
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

		await queryInterface.createTable('attribute_type', {
			id: {
				type: Sequelize.UUID,
				allowNull: false,
				defaultValue: Sequelize.literal('uuid_generate_v4()'),
				primaryKey: true,
			},
			code: {
				type: Sequelize.STRING(32),
				allowNull: false,
				unique: true,
			},
			label: {
				type: Sequelize.STRING(48),
				allowNull: false,
			},
			/**
			 * Cómo se imprime el valor en el nombre compuesto. El color y la talla
			 * se imprimen solos ("Amarillo"), pero las cavidades necesitan su
			 * palabra ("6 cavidades"). Va en la tabla y no en el código para que
			 * añadir un tipo nuevo no obligue a tocar la composición
			 */
			valueTemplate: {
				type: Sequelize.STRING(48),
				allowNull: false,
				defaultValue: '{value}',
			},
			/**
			 * Decide el orden de los atributos dentro del nombre compuesto y, por lo
			 * mismo, dentro de la firma: sin un orden fijo, "20 ml · Amarillo · 6
			 * cavidades" y "20 ml · 6 cavidades · Amarillo" serían dos firmas
			 * distintas para la misma presentación
			 */
			sortOrder: {
				type: Sequelize.INTEGER,
				allowNull: false,
				defaultValue: 0,
			},
			active: {
				type: Sequelize.BOOLEAN,
				allowNull: false,
				defaultValue: true,
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
	},

	async down(queryInterface) {
		await queryInterface.dropTable('attribute_type');
		await queryInterface.dropTable('container');
		await queryInterface.dropTable('measurement_unit');
		// El ENUM queda huérfano al soltar la tabla y bloquearía un `up` posterior
		await queryInterface.sequelize.query(
			'DROP TYPE IF EXISTS "enum_measurement_unit_dimension"',
		);
	},
};
