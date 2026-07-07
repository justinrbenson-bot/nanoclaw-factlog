/**
 * Response handler + shutdown callback registries.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * or `onShutdown()` at import time don't hit a TDZ error on the const-array
 * declarations. index.ts imports src/modules/index.js for its side effects,
 * which triggers module registrations that would otherwise happen before
 * index.ts's own const initializers have run.
 *
 * Keep this file dependency-free (log.js and the guard leaf are fine, but
 * nothing from modules/* or index.ts itself). Any file imported here must
 * not in turn import from src/index.ts, or the cycle returns.
 *
 * A handler whose click performs a privileged operation registers with a
 * guard spec: the registry wraps it so the guard's decision stands between
 * the click and the handler, and the wrapped path is the only path. `claims`
 * is the handler's own claim test (does this questionId belong to me?) so an
 * unauthorized click is claimed-and-dropped without stealing other handlers'
 * responses.
 */
import { guard, type GuardActor } from './guard/index.js';
import { log } from './log.js';

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

export interface ResponseGuardSpec {
  /** Dotted guard-catalog action consulted before the handler runs. */
  action: string;
  /** Would this handler claim the response? (Its own row lookup.) */
  claims: (payload: ResponsePayload) => boolean;
}

const responseHandlers: ResponseHandler[] = [];

function responseActor(payload: ResponsePayload): GuardActor {
  if (!payload.userId) return { kind: 'human', userId: '' };
  const userId = payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
  return { kind: 'human', userId };
}

export function registerResponseHandler(handler: ResponseHandler, guardSpec?: ResponseGuardSpec): void {
  if (!guardSpec) {
    responseHandlers.push(handler);
    return;
  }
  responseHandlers.push(async (payload) => {
    if (!guardSpec.claims(payload)) return false;
    const decision = guard({
      action: guardSpec.action,
      actor: responseActor(payload),
      payload: { questionId: payload.questionId, value: payload.value },
    });
    if (decision.effect !== 'allow') {
      // Claim the response so it's not unclaimed-logged, but do nothing.
      log.warn('Response click rejected by guard', {
        action: guardSpec.action,
        questionId: payload.questionId,
        userId: payload.userId,
        reason: decision.reason,
      });
      return true;
    }
    return handler(payload);
  });
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

type ShutdownCallback = () => void | Promise<void>;
const shutdownCallbacks: ShutdownCallback[] = [];

export function onShutdown(cb: ShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getShutdownCallbacks(): readonly ShutdownCallback[] {
  return shutdownCallbacks;
}
