import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { getFillEventsFromTx } from "@/events-sync/handlers/royalties/utils";
import { jest, describe, it } from "@jest/globals";
import { FillPostProcessJob } from "@/jobs/fill-updates/fill-post-process-job";

jest.setTimeout(1000 * 1000);

describe("Royalties", () => {
  it("issue-1", async () => {
    const { fillEvents } = await getFillEventsFromTx(
      "0x67764c4dc1c2701c28f9e9aca743e6556ea555360ed5a80f0508066da7fdb534"
    );
    const job = new FillPostProcessJob();
    await job.process({
      fillEvents,
      attempt: 1,
    });
  });

  it("should-force-use-oder-fee-breakdown", async () => {
    // Sepolia
    const { fillEvents } = await getFillEventsFromTx(
      "0xa4b4ebcbe91fdf0c3e4068d97c694a24c14745d50e8905df4e1514da207653e7"
    );
    const job = new FillPostProcessJob();
    await job.process({
      fillEvents,
      attempt: 1,
    });
  });

  it("orderbook-fee-test", async () => {
    // Sepolia
    const { fillEvents } = await getFillEventsFromTx(
      "0xd9d02e9915cfd5d86964a030afdcd135ca37a5ef4e2ae83f3fba6a1cc124e264"
    );
    const job = new FillPostProcessJob();
    await job.process({
      fillEvents,
      attempt: 1,
    });
  });

  it("fill-event-debug", async () => {
    // Polygon
    const { fillEvents } = await getFillEventsFromTx(
      "0x4b24e19df5444e2c51fe8170deaac4ba9c201357b9c0e50b61e36a13c8b2a9aa"
    );
    const job = new FillPostProcessJob();
    await job.process({
      fillEvents,
      attempt: 1,
    });
  });

  it("fill-event-overflow", async () => {
    // Polygon
    const { fillEvents } = await getFillEventsFromTx(
      // "0x93be06c0ba887a548ed37ddca8308d7957182c01dd3fd9d58024ae236cc37b4a"
      "0xd19c479d0fb04a52397b8ba5e1886c5e2219f06b6cad8d746fa6db38752c5087"
    );
    const job = new FillPostProcessJob();
    await job.process({
      fillEvents,
      attempt: 1,
    });
    // console.log(fillEvents[0]);
  });
});
