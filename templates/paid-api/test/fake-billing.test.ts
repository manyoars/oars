import { describe, expect, it } from 'vitest';
import { BillingProblem } from '../src/billing.js';
import { createFakeBilling } from '../src/fake-billing.js';
import { createClock } from './support.js';

const CUSTOMER = 'cus_buyer';

const hold = (key: string) => ({ customerRef: CUSTOMER, credits: 1, ttlSeconds: 45, idempotencyKey: key });

const setup = (credits: number) => {
  const clock = createClock();
  const fake = createFakeBilling({ now: clock.now });
  fake.grant(CUSTOMER, credits);
  return { clock, fake };
};

// The test double the withCredits tests stand on has to follow R7, or those tests prove nothing.
describe('createFakeBilling follows R7', () => {
  it('N concurrent reservations on one credit yield one hold and N-1 INSUFFICIENT_CREDITS with a checkout URL', async () => {
    const { fake } = setup(1);

    const outcomes = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => fake.reserve(hold(`k-${String(n)}`))));

    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(refused[0]?.reason).toMatchObject({ code: 'INSUFFICIENT_CREDITS', actionUrl: expect.stringMatching(/^https:\/\//) });
  });

  it('replays a live HELD reservation under its key with replayed: true', async () => {
    const { fake } = setup(1);
    const first = await fake.reserve(hold('k-1'));

    const again = await fake.reserve(hold('k-1'));

    expect(again).toMatchObject({ reservationId: first.reservationId, status: 'HELD', replayed: true });
    expect(first.replayed).toBe(false);
  });

  it('replays a COMMITTED reservation with committedAt and a growing replayCount', async () => {
    const { fake } = setup(1);
    const first = await fake.reserve(hold('k-1'));
    await fake.commit(first.reservationId);

    const one = await fake.reserve(hold('k-1'));
    const two = await fake.reserve(hold('k-1'));

    expect([one.replayCount, two.replayCount]).toEqual([1, 2]);
    expect(one).toMatchObject({ status: 'COMMITTED', replayed: true, committedAt: expect.any(String) });
  });

  it('takes a new hold for a RELEASED key and for an EXPIRED one, and keeps the old row', async () => {
    const { clock, fake } = setup(1);
    const released = await fake.reserve(hold('k-1'));
    await fake.release(released.reservationId);
    const afterRelease = await fake.reserve(hold('k-1'));
    clock.advance(46_000);
    const afterExpiry = await fake.reserve(hold('k-1'));

    expect(afterRelease).toMatchObject({ status: 'HELD', replayed: false });
    expect(afterRelease.reservationId).not.toBe(released.reservationId);
    expect(afterExpiry).toMatchObject({ status: 'HELD', replayed: false });
    expect(afterExpiry.reservationId).not.toBe(afterRelease.reservationId);
    await expect(fake.release(released.reservationId)).resolves.toBeUndefined();
  });

  it('gives two concurrent requests on a released key one new hold and one replay', async () => {
    const { fake } = setup(1);
    const released = await fake.reserve(hold('k-1'));
    await fake.release(released.reservationId);

    const [a, b] = await Promise.all([fake.reserve(hold('k-1')), fake.reserve(hold('k-1'))]);

    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.reservationId).toBe(b.reservationId);
  });

  it('commits idempotently and debits the lesser of the hold and the balance', async () => {
    const { fake } = setup(2);
    const reservation = await fake.reserve({ ...hold('k-1'), credits: 2 });
    fake.clawback(CUSTOMER, 1);

    const first = await fake.commit(reservation.reservationId);
    const second = await fake.commit(reservation.reservationId);

    expect(first).toMatchObject({ status: 'COMMITTED', committedCredits: 1, creditsRemaining: 0, replayed: false });
    expect(second).toMatchObject({ committedCredits: 1, replayed: true });
  });

  it.each([
    ['commits after expiry', 'RESERVATION_EXPIRED'],
    ['commits after a release', 'RESERVATION_RELEASED'],
    ['releases after a commit', 'RESERVATION_COMMITTED'],
  ])('refuses a hold that %s with %s', async (step, code) => {
    const { clock, fake } = setup(1);
    const { reservationId } = await fake.reserve(hold('k-1'));
    if (step === 'commits after expiry') clock.advance(46_000);
    if (step === 'commits after a release') await fake.release(reservationId);
    if (step === 'releases after a commit') await fake.commit(reservationId);

    const refused = step === 'releases after a commit' ? fake.release(reservationId) : fake.commit(reservationId);

    await expect(refused).rejects.toBeInstanceOf(BillingProblem);
    await expect(refused).rejects.toMatchObject({ status: 409, code });
  });

  it('answers a commit of an unknown reservation with 404 RESERVATION_NOT_FOUND', async () => {
    const { fake } = setup(1);

    await expect(fake.commit('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404, code: 'RESERVATION_NOT_FOUND' });
  });

  it('counts live holds out of creditsAvailable and leaves creditsRemaining as the ledger balance', async () => {
    const { fake } = setup(3);
    await fake.reserve(hold('k-1'));

    expect(await fake.balance(CUSTOMER)).toMatchObject({ creditsRemaining: 3, creditsHeld: 1, creditsAvailable: 2 });
  });

  it('credits a bought pack at once, so local development needs no checkout', async () => {
    const { fake } = setup(0);

    const { checkoutUrl } = await fake.checkout(CUSTOMER, 'calls-100');

    expect(checkoutUrl).toMatch(/^https?:\/\//);
    expect((await fake.balance(CUSTOMER)).creditsRemaining).toBe(100);
  });

  it('refuses an unknown price ref with 404 PRICE_NOT_FOUND', async () => {
    const { fake } = setup(0);

    await expect(fake.checkout(CUSTOMER, 'nope')).rejects.toMatchObject({ status: 404, code: 'PRICE_NOT_FOUND' });
  });
});
