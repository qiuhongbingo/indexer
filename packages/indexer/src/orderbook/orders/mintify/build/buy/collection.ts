import * as Sdk from "@reservoir0x/sdk";

import { getBuildInfo } from "@/orderbook/orders/mintify/build/utils";
import {
  BuyCollectionBuilderBase,
  BuildOrderOptions,
} from "@/orderbook/orders/seaport-base/build/buy/collection";

export const build = async (options: BuildOrderOptions) => {
  const builder = new BuyCollectionBuilderBase(getBuildInfo);
  return builder.build(options, Sdk.Mintify.Order);
};
