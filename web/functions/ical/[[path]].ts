import { forward, type Ctx } from '../../functions-lib/proxy';

// Eksport iCal dla Booking.com/Airbnb — bez logowania, chroniony długim losowym tokenem w adresie.
export const onRequestGet = (ctx: Ctx) => forward(ctx, false);
