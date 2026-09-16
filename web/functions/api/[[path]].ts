import { forward, verifyAccess, type Ctx } from '../../functions-lib/proxy';

export const onRequest = async (ctx: Ctx) => {
  const denied = await verifyAccess(ctx.request, ctx.env);
  if (denied) return Response.json({ error: denied }, { status: 401 });
  return forward(ctx, true);
};
