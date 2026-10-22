/*
 * Imprime contra qué servidor se va a trabajar, leyendo las mismas variables
 * DB_* que va a usar sequelize-cli.
 *
 * Existe porque la salida de sequelize-cli dice "Using environment
 * development" pase lo que pase: config/config.js define development, test y
 * production exactamente igual, así que esa etiqueta no dice nada del destino
 * real. Lo único que decide el destino es DB_HOST/DB_PORT/DB_NAME.
 *
 * Sirve además para que un fallo de contraseña salga aquí, con un mensaje
 * claro, y no enterrado en el arranque de sequelize-cli.
 *
 * Sin SSL, igual que src/config/database.ts y config/config.js.
 */
const dotenv = require('dotenv');
const { Client } = require('pg');

// Mismo orden que config/config.js. dotenv no sobrescribe lo que ya está en el
// entorno, así que las variables inyectadas por migrate.ps1 ganan sobre .env,
// y sin inyectar nada esto describe la base local.
dotenv.config();
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

(async () => {
	const client = new Client({
		host: process.env.DB_HOST,
		port: Number(process.env.DB_PORT),
		database: process.env.DB_NAME,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
	});

	try {
		await client.connect();

		const { rows } = await client.query(
			`SELECT current_database() AS db,
			        current_user AS usr,
			        substring(version() from 'PostgreSQL [0-9.]+') AS version`,
		);
		const info = rows[0];

		// En una base recién creada la tabla aún no existe, y eso no es un error.
		let applied = 'sin tabla SequelizeMeta';
		try {
			const meta = await client.query('SELECT count(*)::int AS n FROM "SequelizeMeta"');
			applied = `${meta.rows[0].n} migraciones aplicadas`;
		} catch {
			/* se queda el valor por defecto */
		}

		console.log(`  connected : ${info.usr}@${process.env.DB_HOST}:${process.env.DB_PORT}/${info.db}`);
		console.log(`  server    : ${info.version}`);
		console.log(`  state     : ${applied}`);
	} catch (err) {
		console.error(`  connection failed: ${err.message}`);
		process.exitCode = 1;
	} finally {
		await client.end().catch(() => {});
	}
})();
