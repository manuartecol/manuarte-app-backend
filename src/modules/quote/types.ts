import { CreateQuoteItemDto } from '../quote-item/types';

export enum QuoteStatus {
	ACCEPTED = 'ACCEPTED',
	PENDING = 'PENDING',
	CANCELED = 'CANCELED',
	REVISION = 'REVISION',
	OVERDUE = 'OVERDUE',
}

export interface CreateQuoteDto {
	shopSlug?: string;
	shopId?: string;
	items: CreateQuoteItemDto[];
	status: QuoteStatus;
	discountType: string;
	discount: number;
	shipping: number;
	requestedBy: string;
	currency?: 'COP' | 'USD';
}

export interface UpdateQuoteDto extends CreateQuoteDto {
	id: string;
}
