import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

import { checkCollectionHasStake } from "../../utils/contract";
import { jest, describe, it, expect } from "@jest/globals";

jest.setTimeout(1000 * 1000);

describe("Contract", () => {
  it("check-contract-has-staking-by-keywords", async () => {
    const skipCombinations = [
      // Quirklings
      "0x8f1b132e9fd2b9a2b210baa186bf1ae650adf7ac:1",
      // Quirkies
      "0xd4b7d9bb20fa20ddada9ecef8a7355ca983cccb1:1",
      // Creepz
      "0x5946aeaab44e65eb370ffaa6a7ef2218cff9b47d:1",
      // Kubz
      "0xeb2dfc54ebafca8f50efcc1e21a9d100b5aeb349:1",
      // Ordinal Kubz
      "0xc589770757cd0d372c54568bf7e5e1d56b958015:1",
      // TheMafiaAnimalsSoldiers
      "0x99f419934192f8de7bf53b490d5bdb88527654bf:1",
      // Valeria Games Genesis Lands
      "0x2187093a2736442d0b5c5d5464b98fc703e3b88d:1",
      // Potatoz
      "0x39ee2c7b3cb80254225884ca001f57118c8f21b6:1",
      // The Plague
      "0xc379e535caff250a01caa6c3724ed1359fe5c29b:1",
      // JRNYERS
      "0xf6228c82fc2404d90827d9d7a1340106a3407b06:1",
    ];

    for (const skipCombination of skipCombinations) {
      const collection = skipCombination.split(":")[0];
      const staked = await checkCollectionHasStake(collection);
      expect(staked).toBe(true);
    }
  });
});
