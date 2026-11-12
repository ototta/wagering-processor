
import { Money } from './money';

describe('Money', () => {
  it('should create money with two decimal places', () => {
    const money = Money.create('100', 'BRL');

    expect(money.toString()).toBe('100.00');
  });

  it('should add monetary values', () => {
    const first = Money.create('100.50', 'BRL');
    const second = Money.create('25.25', 'BRL');

    expect(first.add(second).toString()).toBe('125.75');
  });

  it('should subtract monetary values', () => {
    const first = Money.create('100.00', 'BRL');
    const second = Money.create('30.00', 'BRL');

    expect(first.subtract(second).toString()).toBe('70.00');
  });

  it('should compare monetary values', () => {
    const first = Money.create('100.00', 'BRL');
    const second = Money.create('80.00', 'BRL');

    expect(first.isGreaterThan(second)).toBe(true);
    expect(second.isLessThan(first)).toBe(true);
  });

  it('should reject different currencies', () => {
    const first = Money.create('100.00', 'BRL');
    const second = Money.create('100.00', 'USD');

    expect(() => first.add(second)).toThrow('Currency mismatch');
  });

  it('should reject invalid currency', () => {
    expect(() => Money.create('100.00', 'BR')).toThrow(
      'Invalid currency',
    );
  });

  it('should reject more than two decimal places', () => {
    expect(() => Money.create('10.999', 'BRL')).toThrow(
      'Invalid monetary amount',
    );
  });
});
