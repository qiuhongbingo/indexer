import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { jest, describe, it } from "@jest/globals";
import OrderUpdatesByMakerJob from "@/jobs/order-updates/order-updates-by-maker-job";

jest.setTimeout(1000 * 1000);

describe("Order Updates", () => {
  it("issue", async () => {
    const job = new OrderUpdatesByMakerJob();
    const maker = "0x2ff895e051f7a1c29c2d3bdab35c4960e3e1ec72";
    const contract = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    await job.process({
      context: "test",
      maker,
      // Information regarding what triggered the job
      trigger: {
        kind: "balance-change",
        txHash: "0xa8286d6077f2939a74dcd152ac780a10d2b96637a4a5c8b17015ecd8f685ed60",
        txTimestamp: 1713163675,
      },
      data: {
        kind: "buy-balance",
        contract,
      },
    });
  });
});
