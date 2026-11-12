
import Decimal from 'decimal.js';

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static create(amount: string, currency: string): Money {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid currency');
    }

    if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      throw new Error('Invalid monetary amount');
    }

    const value = new Decimal(amount);

    if (!value.isFinite()) {
      throw new Error('Invalid monetary amount');
    }

    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(
      this.value.minus(other.value),
      this.currency,
    );
  }

  isGreaterThan(other: Money): boolean {
    this.ensureSameCurrency(other);

    return this.value.greaterThan(other.value);
  }

  isLessThan(other: Money): boolean {
    this.ensureSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  isEqualTo(other: Money): boolean {
    this.ensureSameCurrency(other);

    return this.value.equals(other.value);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private ensureSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('Currency mismatch');
    }
  }
}
