/* eslint-disable no-undef */
'use strict';

/**
 * Categorías y grupos pasan de MAYÚSCULAS al formato de los nombres de
 * producto. Lista explícita para poder revisarla: las que no estén aquí, creadas
 * después, se dejan como están y se avisan en consola. El modelo de categoría ya
 * aplica el formato a las nuevas.
 */
const NAMES = {
	ACEITES: 'Aceites',
	'ACEITES ESENCIALES': 'Aceites Esenciales',
	'ACEITES VEGETALES': 'Aceites Vegetales',
	BASES: 'Bases',
	'BASES DE JABON DE GLICERINA': 'Bases de Jabón de Glicerina',
	'BASES PRODUCTOS DE CUIDADO PERSONAL': 'Bases Productos de Cuidado Personal',
	CERAS: 'Ceras',
	'CERAS / PARAFINAS /ADITIVOS': 'Ceras / Parafinas / Aditivos',
	COLORANTES: 'Colorantes',
	'COLORANTES PARA JABONES': 'Colorantes para Jabones',
	'COLORANTES PARA VELAS': 'Colorantes para Velas',
	COMPLEMENTOS: 'Complementos',
	ENVASES: 'Envases',
	'ENVASES DE VIDRIO': 'Envases de Vidrio',
	'ENVASES DE YESO (PARA MACETAS O VELAS)':
		'Envases de Yeso (para Macetas o Velas)',
	'ENVASES PLASTICOS': 'Envases Plásticos',
	EXTRACTOS: 'Extractos',
	'EXTRACTOS NATURALES': 'Extractos Naturales',
	FRAGANCIAS: 'Fragancias',
	'FRAGANCIAS JABONES / VELAS / CUIDADO PERSONAL':
		'Fragancias Jabones / Velas / Cuidado Personal',
	GELES: 'Geles',
	'GEL PARA VELAS': 'Gel para Velas',
	INGREDIENTES: 'Ingredientes',
	'INGREDIENTES ACTIVOS / INSUMOS / ADORNOS':
		'Ingredientes Activos / Insumos / Adornos',
	MECHAS: 'Mechas',
	'MECHAS/PABILOS - PORTAMECHAS': 'Mechas / Pabilos - Portamechas',
	MICAS: 'Micas',
	MOLDES: 'Moldes',
	'MOLDES PARA JABONES': 'Moldes para Jabones',
	'MOLDES PARA VELAS': 'Moldes para Velas',
	'MOLDES VARIOS': 'Moldes Varios',
	UTENSILIOS: 'Utensilios',
	VARIOS: 'Varios',
	'VARIOS / PRODUCTOS QUIMICOS': 'Varios / Productos Químicos',
};

const rename = async (queryInterface, table, from, transaction) => {
	const [rows] = await queryInterface.sequelize.query(
		`SELECT name FROM ${table}`,
		{ transaction },
	);

	for (const { name } of rows) {
		const target = from(name);
		if (!target) {
			console.log(`${table}: left unchanged "${name}"`);
			continue;
		}

		await queryInterface.sequelize.query(
			`UPDATE ${table} SET name = :target WHERE name = :name`,
			{ replacements: { target, name }, transaction },
		);
	}
};

const toFormatted = name => NAMES[name] ?? null;
const toUpper = name =>
	Object.values(NAMES).includes(name)
		? Object.keys(NAMES).find(key => NAMES[key] === name)
		: null;

module.exports = {
	async up(queryInterface) {
		await queryInterface.sequelize.transaction(async transaction => {
			await rename(
				queryInterface,
				'product_category_group',
				toFormatted,
				transaction,
			);
			await rename(
				queryInterface,
				'product_category',
				toFormatted,
				transaction,
			);
		});
	},

	async down(queryInterface) {
		await queryInterface.sequelize.transaction(async transaction => {
			await rename(
				queryInterface,
				'product_category_group',
				toUpper,
				transaction,
			);
			await rename(queryInterface, 'product_category', toUpper, transaction);
		});
	},
};
