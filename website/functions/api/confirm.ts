/**
 * GET /api/confirm?token= — confirms a waitlist address (D-426). Logic: functions/_lib/waitlist.ts.
 */
import { confirm, type WaitlistEnv } from '../_lib/waitlist.ts';

export const onRequestGet = ({ request, env }: { request: Request; env: WaitlistEnv }): Promise<Response> =>
  confirm(request, env);
