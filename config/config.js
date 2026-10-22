/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */
const dotenv = require('dotenv');
dotenv.config();

const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${env}` });

/**
 * El nombre del entorno NO elige una base de datos.
 *
 * sequelize-cli usa NODE_ENV (o --env) para escoger una clave de este objeto,
 * pero las tres apuntan a la misma configuración: el destino lo deciden
 * únicamente DB_HOST, DB_PORT y DB_NAME. Por eso `--env production` no conecta
 * a producción, y por eso la línea «Using environment "development"» que
 * imprime la CLI no dice nada sobre contra qué base se está trabajando.
 *
 * Para saberlo de verdad, `npm run migrate:env` imprime servidor, base y
 * versión antes de tocar nada (scripts/db-target.js).
 *
 * Las credenciales de Railway no viven en .env: las inyecta scripts/migrate.ps1
 * para un solo comando. dotenv no sobrescribe lo que ya existe en el entorno,
 * así que lo inyectado gana sobre el .env local.
 *
 * Se conservan las tres claves, aunque sean la misma, porque sequelize-cli
 * falla si NODE_ENV nombra una que no existe, y los comandos de build y start
 * de Railway se configuran en su panel, fuera de este repositorio.
 */
const config = {
	username: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	dialect: 'postgres',
};

module.exports = {
	development: config,
	test: config,
	production: config,
};
