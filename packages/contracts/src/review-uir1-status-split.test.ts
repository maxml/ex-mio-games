// Re-review of the UI rework fix round (bf0f3cc..961aedf). Written by the re-reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-rereview.md.
//
// UIRR-4 (note, choke point for UIR-1, green guard): UIR-1 (6739fb0) widened the operator row's status with
//   `needs_review`. The property is a split: the operator queue may carry it, a player view never may (W-5,
//   CONTRACTS.md "the player widget never receives it"). No contract test pinned either side; the only red
//   test for a reverted operator enum was web's http-operator.test (through the mock seed), and nothing went
//   red if the player view were widened too.
//   Mutations re-applied by the re-reviewer:
//   - web-api.ts OperatorRedemptionView `status: RedemptionStatus` (UIR-1 reverted) -> this package's jest
//     stayed green (13 suites, 122 tests); "the operator row carries needs_review" below goes red.
//   - web-api.ts PlayerRedemptionView `status: OperatorRedemptionStatus` (the widening leaks to players)
//     -> "a player redemption can never say needs_review" below goes red.
import { OperatorRedemptionView, PlayerRedemptionView, RedemptionStatus } from './index';

const row = { id: 'r1', item: '10 EUR bonus', coins: 900 };

describe('UIRR-4 needs_review is an operator word only', () => {
  it('the operator row carries needs_review', () => {
    expect(
      OperatorRedemptionView.safeParse({
        ...row,
        player: 'p1',
        status: 'needs_review',
        at: '2026-11-21 14:10',
      }).success,
    ).toBe(true);
  });

  it('a player redemption can never say needs_review; the public words stay four', () => {
    expect(
      PlayerRedemptionView.safeParse({ ...row, itemId: 'i1', status: 'needs_review' }).success,
    ).toBe(false);
    expect(RedemptionStatus.options).toEqual(['pending', 'issuing', 'issued', 'failed_refunded']);
  });
});
