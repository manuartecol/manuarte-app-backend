import { Handler } from 'express';
import { UserService } from './service';

export class UserController {
	private userService;

	constructor(userService: UserService) {
		this.userService = userService;
	}

	getAll: Handler = async (_req, res, next) => {
		try {
			const users = await this.userService.getAll();

			// La lista vacía viaja como arreglo vacío, no como 204 sin cuerpo
			res.status(200).json(users);
		} catch (error) {
			next(error);
		}
	};

	getRoles: Handler = async (_req, res, next) => {
		try {
			const result = await this.userService.getRoles();

			if (result.status === 200) {
				res.status(result.status).json(result.roles);
			} else {
				res.sendStatus(result.status);
			}
		} catch (error) {
			next(error);
		}
	};

	register: Handler = async (req, res, next) => {
		try {
			const result = await this.userService.register(req.body);

			if (result.status === 201) {
				res.status(result.status).json({
					newUser: result.userRegistered,
					message: result.message,
				});
			} else {
				res.sendStatus(result.status);
			}
		} catch (error) {
			next(error);
		}
	};

	update: Handler = async (req, res, next) => {
		try {
			const { personId } = req.params;
			const result = await this.userService.update({
				...req.body,
				personId,
			});

			if (result.status === 200) {
				res
					.status(result.status)
					.json({ updatedUser: result.updatedUser, message: result.message });
			} else {
				res.sendStatus(result.status);
			}
		} catch (error) {
			next(error);
		}
	};

	delete: Handler = async (req, res, next) => {
		try {
			const result = await this.userService.delete(req.params.personId);

			if (result.status === 200) {
				res.status(result.status).json({ message: result.message });
			} else {
				res.sendStatus(result.status);
			}
		} catch (error) {
			next(error);
		}
	};

	setPermissions: Handler = async (req, res, next) => {
		try {
			const { userId } = req.params;
			const { extraPermissions } = req.body;
			const result = await this.userService.setPermissions({
				userId,
				extraPermissions,
			});

			if (result.status === 200) {
				res.status(result.status).json({ message: result.message });
			} else {
				res.sendStatus(result.status);
			}
		} catch (error) {
			next(error);
		}
	};

	getAssignablePermissions: Handler = async (req, res, next) => {
		try {
			const { userId } = req.params;
			const result = await this.userService.getAssignablePermissions(userId);
			if (!result) {
				res.sendStatus(204);
				return;
			}

			res.status(200).json(result.assignablePermissions);
		} catch (error) {
			next(error);
		}
	};
}
