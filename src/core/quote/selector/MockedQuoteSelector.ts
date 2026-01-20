import {IQuoteSelector} from './IQuoteSelector';
import {vi} from 'vitest';

export class MockedQuoteSelector implements IQuoteSelector {
  getBestQuotes = vi.fn();
}
