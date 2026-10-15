import { CorsOptions } from 'cors';
import { ENV } from '../config/env';

const allowedOrigins = ['http://localhost:3000', ENV.FRONTEND_URL];

export const corsOptions: CorsOptions = {
	origin: (
		origin: string | undefined,
		callback: (err: Error | null, allow?: boolean) => void,
	) => {
		if ((origin && allowedOrigins.indexOf(origin) !== -1) || !origin) {
			callback(null, true);
		} else {
			callback(new Error('Not allowed by CORS'));
		}
	},
	optionsSuccessStatus: 200,
};
