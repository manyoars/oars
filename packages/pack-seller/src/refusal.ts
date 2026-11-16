/** What a seller route answers when the platform says no: one stable status and one line, never the platform's own text. */
export interface Refusal {
  status: number;
  message: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export const BAD_REQUEST: Refusal = { status: 400, message: 'The request was refused.' };
export const NO_CREDITS: Refusal = { status: 402, message: 'No credits are available.' };
export const NOT_FOUND: Refusal = { status: 404, message: 'Not found.' };
export const CONFLICT: Refusal = { status: 409, message: 'The request conflicts with the current state.' };
export const BUSY: Refusal = { status: 503, message: 'Busy. Try again later.' };
export const UNAVAILABLE: Refusal = { status: 502, message: 'The seller cannot reach billing right now.' };

/**
 * One seller status per platform status class. The seller's own key failing (401, 403) is the seller's fault, not the buyer's, so it reads as
 * `UNAVAILABLE` and never tells a buyer which credential the platform rejected.
 */
export const refusalFor = (platformStatus: number): Refusal => {
  switch (platformStatus) {
    case 400:
      return BAD_REQUEST;
    case 402:
      return NO_CREDITS;
    case 404:
    case 410:
      return NOT_FOUND;
    case 409:
    case 422:
    case 423:
      return CONFLICT;
    case 429:
      return BUSY;
    default:
      return UNAVAILABLE;
  }
};
