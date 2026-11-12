// The dashboard's write routes that live in their own modules, in one place so the request handler gains no lines per route:
// POST /limit-resets (issue #1159) and POST /direct (issue #1164, the direct control switch and Undo).
import { limitResetsRoute } from './resetswrite.mjs';
import { directRoute } from './directwrite.mjs';

export const extraWrites = ctx => ({ '/limit-resets': limitResetsRoute(ctx), '/direct': directRoute(ctx) });
