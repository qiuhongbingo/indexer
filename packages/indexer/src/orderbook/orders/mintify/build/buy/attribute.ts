import * as Sdk from "@reservoir0x/sdk";

import { getBuildInfo } from "@/orderbook/orders/mintify/build/utils";
import {
  BuyAttributeBuilderBase,
  BuildOrderOptions,
} from "@/orderbook/orders/seaport-base/build/buy/attribute";

export const build = async (options: BuildOrderOptions) => {
  const builder = new BuyAttributeBuilderBase(getBuildInfo);
  return builder.build(options, Sdk.Mintify.Order);
};
