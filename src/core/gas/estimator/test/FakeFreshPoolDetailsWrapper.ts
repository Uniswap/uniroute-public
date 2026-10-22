import {IFreshPoolDetailsWrapper} from '../../../../stores/pool/FreshPoolDetailsWrapper';

export class FakeFreshPoolDetailsWrapper implements IFreshPoolDetailsWrapper {
  constructor(
    public readonly getPoolDetailsForRoute: IFreshPoolDetailsWrapper['getPoolDetailsForRoute'] = async () => {
      throw new Error('Gas heuristics must not fetch pool details');
    },
    public readonly getPoolsDetails: IFreshPoolDetailsWrapper['getPoolsDetails'] = async () => {
      throw new Error('Gas heuristics must not fetch pool details');
    }
  ) {}
}
