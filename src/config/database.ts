import { Sequelize } from 'sequelize';
import { ENV } from './env';

const { DB_NAME, DB_USER, DB_PASSWORD, DB_HOST, DB_PORT } = ENV;

export const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
	host: DB_HOST,
	port: DB_PORT,
	dialect: 'postgres',
	pool: {
		max: 5,
		min: 1,
		acquire: 30000,
		idle: 10000,
	},
});

let dbReady = false;

export async function connectToDatabase(retries = 5, delay = 5000) {
	while (retries > 0) {
		try {
			await sequelize.authenticate();
			await sequelize.sync();
			dbReady = true;
			console.log('✅ Connected to database successfully');
			break;
		} catch (error) {
			console.error(
				`❌ Database connection failed. Retries left: ${retries - 1}`,
			);
			if (error instanceof Error) {
				console.error(error.message);
			} else {
				console.error('Unknown error:', error);
			}

			retries--;
			await new Promise(res => setTimeout(res, delay));
		}
	}

	if (!dbReady) {
		console.error(
			'🚨 Failed to connect to the database after multiple attempts.',
		);
	}
}

export function startDBReconnectLoop(interval = 15000) {
	setInterval(async () => {
		if (!dbReady) {
			console.log('🔄 Reconnecting to the database...');
			await connectToDatabase(1, 1000);
		}
	}, interval);
}
