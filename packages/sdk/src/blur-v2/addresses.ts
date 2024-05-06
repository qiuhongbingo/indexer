import { ChainIdToAddress, Network } from "../utils";

export const Exchange: ChainIdToAddress = {
  [Network.Ethereum]: "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5",
  [Network.Blast]: "0x0f41639352b190f352baddd32856038f1c230ced",
};

export const Delegate: ChainIdToAddress = {
  [Network.Ethereum]: "0x2f18f339620a63e43f0839eeb18d7de1e1be4dfb",
  [Network.Blast]: "0x17d8a54d35842133b123a6e6fc57d51338a4aee5",
};
