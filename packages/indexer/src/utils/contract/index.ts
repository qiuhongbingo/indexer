import * as qs from "querystring";
import axios from "axios";

import { whatsabi } from "@shazow/whatsabi";
import { baseProvider } from "@/common/provider";
import { getAddress } from "ethers/lib/utils";

async function lookupFunctions(functions: string[] = [], events: string[] = []) {
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
    // skip errors
  }

  return {
    functions: [],
    events: [],
  };
}

async function getContractSelectors(contract: string): Promise<string[]> {
  const code = await baseProvider.getCode(contract);
  const abis = whatsabi.abiFromBytecode(code);
  const selectors: string[] = [];
  abis.forEach((c) => {
    if (c.type != "event") {
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
}

export async function getContractInfo(contract: string) {
  const selectors: string[] = await getContractSelectors(contract);
  const result = await lookupFunctions(selectors);
  return result;
}

export async function checkCollectionHasStake(collection: string) {
  const iface = await getContractInfo(collection);
  const keywords = ["stake", "lock"];
  const matched = iface.functions.some((c) =>
    keywords.some((keyword) => c.text_signature.toLowerCase().includes(keyword))
  );
  return matched;
}
