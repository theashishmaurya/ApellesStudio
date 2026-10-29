/**
 * GET + POST /api/unsubscribe?token= — the email link and the one-click
 * List-Unsubscribe-Post (D-426). Logic: functions/_lib/waitlist.ts.
 */
import { unsubscribe, type WaitlistEnv } from '../_lib/waitlist.ts';

type Context = { request: Request; env: WaitlistEnv };

export const onRequestGet = ({ request, env }: Context): Promise<Response> => unsubscribe(request, env);
export const onRequestPost = ({ request, env }: Context): Promise<Response> => unsubscribe(request, env);
