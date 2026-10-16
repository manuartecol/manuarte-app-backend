/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
'use strict';

/**
 * Reproduce un payload de webhook de WhatsApp contra el endpoint local del
 * agente, para ejercitar el pipeline real sin depender de que Meta entregue un
 * evento. El endpoint del webhook es público (no pasa por verifyJWT), así que
 * no hace falta token.
 *
 *   npm run wa:replay -- echo-human-agent
 *   npm run wa:replay -- inbound-customer --fresh-ids
 *   npm run wa:replay -- inbound-customer --from 573001112233
 *   npm run wa:replay -- inbound-customer --line EC
 *   npm run wa:replay -- inbound-customer --url http://localhost:5050
 *   npm run wa:replay -- --list
 *
 * Los fixtures NO llevan la línea escrita: usan marcadores que se resuelven
 * aquí desde el .env, igual que los lee la aplicación. Por eso el mismo fixture
 * sirve para cualquier línea: --line elige cuál (CO por defecto), que es como se
 * comprueba que dos líneas no comparten sesión ni pausa. Así no vuelven a quedar
 * obsoletos cada vez que cambia el número, que es justo lo que pasó cuando la
 * línea de pruebas se sustituyó por la de la tienda.
 *
 * Los timestamps se reescriben a "ahora" en cada ejecución, porque el agente
 * descarta mensajes de más de 5 minutos.
 *
 * Los wamid se mantienen tal cual por defecto: así, ejecutar dos veces el mismo
 * fixture ejercita la deduplicación (la segunda vez debe ignorarse). Con
 * --fresh-ids se aleatorizan para simular mensajes nuevos.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Mismo orden de carga que src/config/env.ts y config/config.js.
dotenv.config();
dotenv.config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

const FIXTURES_DIR = path.join(__dirname, 'wa-fixtures');
const DEFAULT_URL = `http://localhost:${process.env.PORT || 5000}`;
const WEBHOOK_PATH = '/api/v1/whatsapp-agent/webhook';

const listFixtures = () =>
	fs
		.readdirSync(FIXTURES_DIR)
		.filter(f => f.endsWith('.json'))
		.map(f => f.replace(/\.json$/, ''))
		.sort();

const LINES = ['CO', 'EC'];

const firstAllowlisted = iso =>
	(process.env[`WHATSAPP_LINE_${iso}_AI_ALLOWLIST`] || '')
		.split(',')
		.map(n => n.replace(/\D/g, ''))
		.find(n => n.length > 0) || '';

/**
 * Cada marcador, con la variable de la que sale y por qué hace falta. El
 * mensaje de error dice qué configurar, en vez de enviar un payload a medias
 * que el agente descartaría en silencio.
 */
const placeholders = (from, iso) => ({
	__LINE_PHONE_NUMBER_ID__: {
		value: process.env[`WHATSAPP_LINE_${iso}_PHONE_NUMBER_ID`],
		hint: `WHATSAPP_LINE_${iso}_PHONE_NUMBER_ID en .env`,
	},
	__LINE_BUSINESS_PHONE__: {
		value: process.env[`WHATSAPP_LINE_${iso}_BUSINESS_PHONE`],
		hint: `WHATSAPP_LINE_${iso}_BUSINESS_PHONE en .env`,
	},
	__CUSTOMER_PHONE__: {
		value: from || firstAllowlisted(iso),
		hint: `--from <número>, o el primer número de WHATSAPP_LINE_${iso}_AI_ALLOWLIST`,
	},
	__SHOP_PHONE__: {
		value: process.env[`SHOP_NOTIFY_${iso}_PHONE`],
		hint: `SHOP_NOTIFY_${iso}_PHONE en .env`,
	},
});

/** Reescribe timestamps, wamid y marcadores de línea/teléfono. */
const prepare = (node, ctx) => {
	if (Array.isArray(node)) return node.map(item => prepare(item, ctx));
	if (node === null || typeof node !== 'object') return node;

	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'timestamp' && typeof value === 'string') {
			out[key] = String(ctx.nowSeconds);
		} else if (
			ctx.freshIds &&
			key === 'id' &&
			typeof value === 'string' &&
			value.startsWith('wamid.')
		) {
			out[key] = `${value}-${ctx.idSuffix}`;
		} else if (typeof value === 'string' && ctx.resolved[value]) {
			ctx.used.add(value);
			out[key] = ctx.resolved[value];
		} else {
			out[key] = prepare(value, ctx);
		}
	}
	return out;
};

/** Marcadores presentes en el fixture tal cual está en disco. */
const placeholdersIn = (raw, names) => names.filter(n => raw.includes(`"${n}"`));

const main = async () => {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes('--list') || args.includes('--help')) {
		console.log('Fixtures disponibles:\n');
		for (const name of listFixtures()) console.log(`  ${name}`);
		console.log(
			'\nUso: npm run wa:replay -- <fixture> [--line CO|EC] [--from <número>] [--url <base>] [--fresh-ids]',
		);
		process.exit(args.length === 0 ? 1 : 0);
	}

	const name = args[0].replace(/\.json$/, '');
	const valueAfter = flag => {
		const i = args.indexOf(flag);
		return i !== -1 ? args[i + 1] : undefined;
	};
	const baseUrl = valueAfter('--url') || DEFAULT_URL;
	const from = (valueAfter('--from') || '').replace(/\D/g, '');
	const freshIds = args.includes('--fresh-ids');
	const iso = (valueAfter('--line') || 'CO').toUpperCase();

	if (!LINES.includes(iso)) {
		console.error(`Línea desconocida: ${iso}. Opciones: ${LINES.join(', ')}`);
		process.exit(1);
	}

	const fixturePath = path.join(FIXTURES_DIR, `${name}.json`);
	if (!fs.existsSync(fixturePath)) {
		console.error(`Fixture no encontrado: ${name}`);
		console.error(`Disponibles: ${listFixtures().join(', ')}`);
		process.exit(1);
	}

	const raw = fs.readFileSync(fixturePath, 'utf8');
	const table = placeholders(from, iso);
	const needed = placeholdersIn(raw, Object.keys(table));

	const missing = needed.filter(n => !table[n].value);
	if (missing.length > 0) {
		console.error(`El fixture "${name}" necesita valores que no están configurados:\n`);
		for (const n of missing) console.error(`  ${n}  →  ${table[n].hint}`);
		console.error(
			'\nSin ellos el agente ignoraría el evento en silencio, así que no se envía nada.',
		);
		process.exit(1);
	}

	const resolved = Object.fromEntries(
		needed.map(n => [n, String(table[n].value)]),
	);

	const payload = prepare(JSON.parse(raw), {
		freshIds,
		nowSeconds: Math.floor(Date.now() / 1000),
		idSuffix: Math.random().toString(36).slice(2, 8),
		resolved,
		used: new Set(),
	});

	const target = `${baseUrl}${WEBHOOK_PATH}`;
	console.log(
		`POST ${target}  (fixture: ${name}, línea: ${iso}${freshIds ? ', fresh ids' : ''})`,
	);
	for (const [marker, value] of Object.entries(resolved)) {
		console.log(`  ${marker} = ${value}`);
	}
	// Decirlo antes de enviar: si el número está en la allowlist, el agente le
	// responde de verdad por WhatsApp.
	if (resolved.__CUSTOMER_PHONE__) {
		console.log(
			`\n⚠️  Si ${resolved.__CUSTOMER_PHONE__} está en la allowlist, recibirá un WhatsApp real.`,
		);
	}

	const response = await fetch(target, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	console.log(`\n→ ${response.status} ${response.statusText}`);
	console.log(
		'El resultado se observa en los logs del servidor y en whatsapp_message_log.',
	);
};

main().catch(err => {
	console.error('Replay falló:', err.message);
	process.exit(1);
});
