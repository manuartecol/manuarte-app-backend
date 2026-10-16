# Fixtures de webhook del agente de WhatsApp

Payloads de ejemplo para ejercitar el pipeline del agente sin depender de que
Meta entregue un evento real. Se envían con:

```bash
npm run wa:replay -- <fixture>
npm run wa:replay -- <fixture> --line EC
npm run wa:replay -- --list
```

El script reescribe los `timestamp` a "ahora" en cada ejecución (el agente
descarta mensajes de más de 5 minutos) y mantiene los `wamid` tal cual, de modo
que **ejecutar el mismo fixture dos veces ejercita la deduplicación**: la
segunda vez debe ignorarse. Con `--fresh-ids` se aleatorizan.

## Marcadores: los fixtures no llevan la línea escrita

Los payloads usan marcadores que `wa-replay.js` resuelve desde el `.env` al
enviarlos, leyéndolo igual que la aplicación. Antes los números estaban
quemados en los JSON y, al sustituir la línea de pruebas por la de la tienda,
los once fixtures quedaron apuntando a un `phone_number_id` ya inexistente: el
webhook devolvía 200 y el agente lo ignoraba por línea no registrada, así que
parecían funcionar sin ejercitar nada.

`--line CO|EC` elige la línea; por defecto `CO`. Como el mismo fixture se
resuelve contra cualquiera de las dos, enviarlo a una y a otra es la forma de
comprobar que no comparten sesión ni pausa.

| Marcador | Sale de (`<L>` = línea elegida) |
|---|---|
| `__LINE_PHONE_NUMBER_ID__` | `WHATSAPP_LINE_<L>_PHONE_NUMBER_ID` |
| `__LINE_BUSINESS_PHONE__` | `WHATSAPP_LINE_<L>_BUSINESS_PHONE` |
| `__CUSTOMER_PHONE__` | `--from <número>`, o el primer número de `WHATSAPP_LINE_<L>_AI_ALLOWLIST` |
| `__SHOP_PHONE__` | `SHOP_NOTIFY_<L>_PHONE` |

Si falta alguno, el script **no envía nada** y dice qué configurar, en vez de
mandar un payload que se descartaría en silencio.

Como `__CUSTOMER_PHONE__` sale de la allowlist, los fixtures entrantes
provocan respuestas **reales** por WhatsApp a ese número. El script lo avisa
antes de enviar. Con `--from <número>` se usa otro.

## Números fijos

Estos sí van escritos en los JSON, porque el escenario depende de su valor
concreto:

| Rol | Valor |
|---|---|
| Cliente no autorizado | `573009998877` |
| Cliente con prefijo de Ecuador | `593991234567` |
| Línea no registrada | `999999999999999` |

## Qué comprueba cada fixture

| Fixture | Esperado |
|---|---|
| `inbound-customer` | La IA procesa el mensaje y responde |
| `inbound-duplicate` | Mismo `wamid` que el anterior → se descarta, sin segunda respuesta |
| `inbound-not-allowlisted` | Sin respuesta; log con `intent='skipped:allowlist'` |
| `inbound-unknown-line` | `phone_number_id` no registrado → ignorado, sin tocar sesión |
| `inbound-ec-customer-co-line` | Cliente `+593` en la línea CO → contexto de Barranquilla y COP |
| `inbound-statuses` | Evento de estado de entrega → ignorado |
| `echo-human-agent` | Pausa la IA para `__CUSTOMER_PHONE__`; log con `source='human'` y `reason='human_reply'` |
| `echo-batch-multiple` | Dos echoes en un payload → **ambos** procesados |
| `echo-self-send` | `wamid` registrado como envío propio → no pausa |
| `echo-revoke` | Mensaje eliminado → no se trata como actividad nueva |
| `echo-to-shop-number` | Echo dirigido a un número de tienda → ignorado por denylist. Con `--line CO`, `SHOP_NOTIFY_CO_PHONE` coincide hoy con el número de la propia línea, así que prueba la denylist sin distinguir ambos casos; con `--line EC` el número de tienda sí es distinto del de la línea |

`echo-self-send` solo demuestra su efecto si el `wamid` está registrado en
Redis. Para provocarlo de verdad, basta con que el agente haya enviado una
respuesta antes (su `wamid` queda en `wa:self-send:*`) y comprobar que el echo
correspondiente no pausa la conversación.
