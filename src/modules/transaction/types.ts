import { CreateTransactionItemDto } from '../transaction-item/types';

export enum TransactionType {
	ENTER = 'ENTER',
	TRANSFER = 'TRANSFER',
	EXIT = 'EXIT',
}

export enum TransactionState {
	SUCCESS = 'SUCCESS',
	PROGRESS = 'PROGRESS',
}

export interface CreateTransactionDto {
	supplierId: string;
	fromId: string;
	toId: string;
	description: string;
	type: TransactionType;
	state: TransactionState;
	items: CreateTransactionItemDto[];
	transferId?: string;
	clientRequestId: string;
}

export type UpdateTransactionDto = Partial<CreateTransactionDto>;

/**
 * Una transferencia creada y todavía sin aceptar, con las unidades ya fuera del
 * origen y aún sin entrar al destino
 */
export interface PendingTransfer {
	id: string;
	name: string;
	// `pg` la devuelve como `Date`; viaja como string en la respuesta HTTP
	createdDate: string | Date;
	fromId: string | null;
	fromName: string | null;
	toId: string | null;
	toName: string | null;
	quantity: number;
}

export type TransactionFilters = {
	state?: TransactionState;
	type?: TransactionType;
	fromId?: string;
	toId?: string;
	dateStart?: string;
	dateEnd?: string;
};
