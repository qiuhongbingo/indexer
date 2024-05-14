import { getAddress } from "@ethersproject/address";
import { whatsabi } from "@shazow/whatsabi";
import * as qs from "querystring";
import axios from "axios";

import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";

const lookupFunctions = async (functions: string[] = [], events: string[] = []) => {
  try {
    const { data } = await axios.get(
      `https://sig.eth.samczsun.com/api/v1/signatures?${qs.stringify({
        function: functions,
        event: events,
      })}`
    );
    return {
      functions: functions
        .map(
          (hex, id) =>
            (data.result.function[hex] || []).map((record: { name: string }) => ({
              id,
              created_at: "",
              text_signature: record.name,
              hex_signature: hex,
              bytes_signature: "",
            }))[0]
        )
        .filter((_) => _),
      events: events
        .map(
          (hex, id) =>
            (data.result.event[hex] || []).map((record: { name: string }) => ({
              id,
              created_at: "",
              text_signature: record.name,
              hex_signature: hex,
              bytes_signature: "",
            }))[0]
        )
        .filter((_) => _),
    };
  } catch (error) {
    // Skip errors
    logger.info(
      "staking-detection",
      JSON.stringify({
        error,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stack: (error as any).stack,
      })
    );
  }

  return {
    functions: [],
    events: [],
  };
};

const getContractSelectors = async (contract: string): Promise<string[]> => {
  const code = await baseProvider.getCode(contract);
  const abi = whatsabi.abiFromBytecode(code);

  const selectors: string[] = [];
  abi.forEach((c) => {
    if (c.type !== "event") {
      selectors.push(c.selector);
    }
  });

  // EIP-1967 Proxy
  if (selectors.includes("0x5c60da1b")) {
    const storageValue = await baseProvider.getStorageAt(
      contract,
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    );
    const proxyImpl = getAddress(storageValue.slice(26));
    return getContractSelectors(proxyImpl);
  }

  return selectors;
};

export const getContractInfo = async (contract: string) =>
  lookupFunctions(await getContractSelectors(contract));

export const checkContractHasStakingKeywords = async (contract: string) => {
  const info = await getContractInfo(contract);

  const keywords = ["stake", "lock"];
  const matched = info.functions.some((c) =>
    keywords.some((keyword) => c.text_signature.toLowerCase().includes(keyword))
  );
  return matched;
};
