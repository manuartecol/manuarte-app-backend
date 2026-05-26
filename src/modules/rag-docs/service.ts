import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { OpenAIService } from '../whatsapp-agent/openai.service';
import { RagDocModel } from './model';

export type RagSearchResult = {
	id: number;
	type: string;
	title: string;
	content: string;
	score: number;
};

const RAG_SIMILARITY_THRESHOLD = 0.6;
const RAG_TOP_K = 3;
const RAG_FAQ_ONLY_THRESHOLD = 0.38;

export class RagDocService {
	constructor(
		private ragDocModel: typeof RagDocModel,
		private openai: OpenAIService,
	) {}

	/**
	 * Busca los documentos más relevantes para la consulta del usuario
	 * usando similitud coseno sobre los embeddings almacenados en pgvector.
	 * Retorna un array vacío si no se encuentran documentos por encima del umbral.
	 * @param docType Si se especifica, filtra por `type` (ej: 'faq', 'datasheet').
	 */
	search = async (
		query: string,
		topK = RAG_TOP_K,
		threshold = RAG_SIMILARITY_THRESHOLD,
		docType?: string,
	): Promise<RagSearchResult[]> => {
		const embedding = await this.openai.getEmbedding(query);
		const embeddingStr = `[${embedding.join(',')}]`;

		const typeFilter = docType ? 'AND type = :docType' : '';
		const replacements: Record<string, string | number> = {
			embedding: embeddingStr,
			threshold,
			topK,
		};
		if (docType) replacements.docType = docType;

		const results = await sequelize.query<RagSearchResult>(
			`SELECT id, type, title, content,
			        1 - (embedding <=> :embedding::vector) AS score
			 FROM rag_docs
			 WHERE 1 - (embedding <=> :embedding::vector) > :threshold
			 ${typeFilter}
			 ORDER BY embedding <=> :embedding::vector
			 LIMIT :topK`,
			{
				replacements,
				type: QueryTypes.SELECT,
			},
		);

		console.log(
			`[RAG] Query: "${query}"${docType ? ` [type=${docType}]` : ''} → ${results.length} result(s) above threshold ${threshold}`,
		);

		return results;
	};

	/**
	 * Búsqueda semántica exclusiva sobre documentos de tipo 'faq' con umbral relajado.
	 * Seguro de usar detrás del gate de intent `general_question` donde ya se descartó
	 * que sea búsqueda de producto.
	 */
	searchFaqs = async (
		query: string,
		topK = RAG_TOP_K,
	): Promise<RagSearchResult[]> => {
		return this.search(query, topK, RAG_FAQ_ONLY_THRESHOLD, 'faq');
	};

	/**
	 * Formatea los resultados del RAG como contexto para el system prompt de OpenAI.
	 */
	formatContext = (results: RagSearchResult[]): string => {
		return results.map(r => `## ${r.title}\n${r.content}`).join('\n\n---\n\n');
	};

	/**
	 * Busca documentos por coincidencia de palabras clave en el título.
	 * Fallback para cuando la búsqueda semántica falla (ej: doc cuyo contenido está en otro idioma).
	 * Las keywords deben venir pre-normalizadas (sin tildes, minúsculas, solo [a-z0-9]).
	 */
	searchByTitle = async (
		keywords: string[],
		topK = RAG_TOP_K,
	): Promise<RagSearchResult[]> => {
		if (keywords.length === 0) return [];

		// La estructura SQL (nombres de placeholder :kw0, :kw1…) se construye desde índices
		// enteros, nunca desde input del usuario. Los valores van en replacements (safe).
		const conditions = keywords
			.map((_, i) => `unaccent(lower(title)) LIKE unaccent(lower(:kw${i}))`)
			.join(' AND ');
		const replacements: Record<string, string | number> = { topK };
		keywords.forEach((k, i) => {
			replacements[`kw${i}`] = `%${k}%`;
		});

		const results = await sequelize.query<{
			id: number;
			type: string;
			title: string;
			content: string;
		}>(
			`SELECT id, type, title, content FROM rag_docs WHERE ${conditions} LIMIT :topK`,
			{ replacements, type: QueryTypes.SELECT },
		);

		console.log(
			`[RAG] Title fallback for [${keywords.join(', ')}] → ${results.length} result(s)`,
		);

		return results.map(r => ({ ...r, score: 0.5 }));
	};
}
