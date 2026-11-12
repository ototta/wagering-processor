
import { Money } from './money';
import { WagerTransactionType } from './wager-transaction.entity';

export class WageringRules {
  static calculateBalance(
    currentBalance: Money,
    amount: Money,
    type: WagerTransactionType,
  ): Money {
    const zero = Money.create('0.00', amount.currency);

    if (!amount.isGreaterThan(zero)) {
      throw new Error('INVALID_AMOUNT');
    }

    switch (type) {
      case WagerTransactionType.OPENING:
      case WagerTransactionType.WIN:
        return currentBalance.add(amount);

      case WagerTransactionType.BET:
        if (currentBalance.isLessThan(amount)) {
          throw new Error('INSUFFICIENT_FUNDS');
        }

        return currentBalance.subtract(amount);

      case WagerTransactionType.LOSS:
        return currentBalance;

      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK:
        throw new Error('REFERENCE_REQUIRED');

      default:
        throw new Error('UNSUPPORTED_TRANSACTION_TYPE');
    }
  }
}
