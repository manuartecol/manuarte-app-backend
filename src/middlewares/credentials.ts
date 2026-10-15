import { NextFunction, Request, Response } from 'express';
import { ENV } from '../config/env';

const allowedOrigins = ['http://localhost:3000', ENV.FRONTEND_URL];

export const credentials = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const origin = req.headers.origin;
	if (allowedOrigins.includes(origin as string)) {
		res.header('Access-Control-Allow-Credentials', 'true');
	}
	next();
};
