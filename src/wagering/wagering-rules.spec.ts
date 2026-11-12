
import { Money } from './money';
import { WageringRules } from './wagering-rules';
import { WagerTransactionType } from './wager-transaction.entity';

describe('WageringRules', () => {
  const balance = Money.create('100.00', 'BRL');
  const amount = Money.create('80.00', 'BRL');

  it('should debit a successful bet', () => {
    const result = WageringRules.calculateBalance(
      balance,
      amount,
      WagerTransactionType.BET,
    );

    expect(result.toString()).toBe('20.00');
  });

  it('should reject a bet with insufficient funds', () => {
    expect(() =>
      WageringRules.calculateBalance(
        Money.create('50.00', 'BRL'),
        amount,
        WagerTransactionType.BET,
      ),
    ).toThrow('INSUFFICIENT_FUNDS');
  });

  it('should credit a winning transaction', () => {
    const result = WageringRules.calculateBalance(
      balance,
      amount,
      WagerTransactionType.WIN,
    );

    expect(result.toString()).toBe('180.00');
  });

  it('should not change balance after a loss', () => {
    const result = WageringRules.calculateBalance(
      balance,
      amount,
      WagerTransactionType.LOSS,
    );

    expect(result.toString()).toBe('100.00');
  });

  it('should reject zero amount', () => {
    expect(() =>
      WageringRules.calculateBalance(
        balance,
        Money.create('0.00', 'BRL'),
        WagerTransactionType.BET,
      ),
    ).toThrow('INVALID_AMOUNT');
  });

  it('should require a reference for refunds', () => {
    expect(() =>
      WageringRules.calculateBalance(
        balance,
        amount,
        WagerTransactionType.REFUND,
      ),
    ).toThrow('REFERENCE_REQUIRED');
  });

  it('should require a reference for rollbacks', () => {
    expect(() =>
      WageringRules.calculateBalance(
        balance,
        amount,
        WagerTransactionType.ROLLBACK,
      ),
    ).toThrow('REFERENCE_REQUIRED');
  });
});
