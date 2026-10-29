/**
 * POST /api/waitlist — beta signup (D-426). Logic and tests: functions/_lib/waitlist.ts.
 */
import { signup, type WaitlistEnv } from '../_lib/waitlist.ts';

export const onRequestPost = ({ request, env }: { request: Request; env: WaitlistEnv }): Promise<Response> =>
  signup(request, env);
