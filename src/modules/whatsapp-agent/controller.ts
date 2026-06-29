import { Handler } from 'express';
import { WhatsAppAgentService } from './service';

export class WhatsAppAgentController {
	private whatsAppAgentService;

	constructor(whatsAppAgentService: WhatsAppAgentService) {
		this.whatsAppAgentService = whatsAppAgentService;
	}

	verifyWebhook: Handler = (req, res, next) => {
		try {
			const mode = req.query['hub.mode'] as string;
			const token = req.query['hub.verify_token'] as string;
			const challenge = req.query['hub.challenge'] as string;

			const result = this.whatsAppAgentService.verifyWebhook(
				mode,
				token,
				challenge,
			);

			if (result.status !== 200) {
				res.status(result.status).json({ message: result.message });
				return;
			}

			res.setHeader('Content-Type', 'text/plain');
			res.status(200).send(result.challenge);
		} catch (error) {
			next(error);
		}
	};

	receiveMessage: Handler = async (req, res, next) => {
		try {
			const result = this.whatsAppAgentService.receiveMessage(req.body);
			res.sendStatus((await result).status);
		} catch (error) {
			next(error);
		}
	};
}
