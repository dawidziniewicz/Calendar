import { forward, type Ctx } from '../../functions-lib/proxy';

// Logowanie (login + hasło) sprawdza serwer w domu; tu tylko przekazujemy żądanie z kluczem API.
export const onRequest = (ctx: Ctx) => forward(ctx, true);
